"""Prepare the explicitly mapped first administrator for a new installation.

Private operator primitive only: no HTTP route, username adoption, task writes
or ingress activation. Enrollment defaults to a disabled provider identity.
The explicit private-enable step aligns the provider with the application mapping
for coordinated backup/recovery while all serving processes and ingress stay off.
"""
import fcntl
import os
import re
from pathlib import Path
import secrets
import stat
import uuid
from urllib.parse import urlsplit

from stack_config import PRODUCTION, STAGING, hostname
from operator_identity import private_read
from gtd_backup import atomic_json


def literal(value):
    return "'"+value.replace("'","''")+"'"


def prepare_owner(admin, database, manifest, journal_path, source_identity, *, enable_private=False, username="owner", timezone="America/New_York"):
    """Resume one pinned enrollment, including lost provider/commit replies.

    `database` is a private, persistent operator session. This function owns its
    lifecycle advisory lock and transaction; do not call inside a transaction.
    The caller must keep application processes/ingress disabled through cutover.
    No result contains a password. The private journal is recovery material.
    """
    from zoneinfo import ZoneInfo
    if not isinstance(username, str) or not re.fullmatch(r'[a-z][a-z0-9._-]{0,63}', username):
        raise ValueError('Use a lowercase administrator username of at most 64 characters')
    ZoneInfo(timezone)
    layout = STAGING if manifest.get('environment') == 'staging' else PRODUCTION
    identity, source_identity = str(uuid.UUID(manifest['database_identity'])), str(uuid.UUID(source_identity))
    issuer = manifest['issuer']
    url = urlsplit(issuer)
    if (manifest.get('environment') != layout.environment or manifest.get('realm') != layout.realm
            or url.scheme != 'https' or url.path != '/realms/'+layout.realm or url.port
            or url.username or url.password or url.query or url.fragment
            or admin.realm != layout.realm or admin.issuer != issuer or admin.base != 'http://127.0.0.1:'+str(layout.ports['identity'])
            or identity == source_identity):
        raise RuntimeError('Owner enrollment requires the explicit production source and destination')
    hostname(url.hostname, layout)
    journal = Path(journal_path)
    if (not journal.is_absolute() or journal.parent != journal.parent.resolve()
            or stat.S_IMODE(journal.parent.stat().st_mode) & 0o077):
        raise RuntimeError('Owner journal requires a private canonical directory')
    descriptor = os.open(journal.with_suffix('.lock'),os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    with os.fdopen(descriptor,'a') as lock:
        meta = os.fstat(lock.fileno())
        if not stat.S_ISREG(meta.st_mode) or meta.st_mode & 0o077:
            raise RuntimeError('Owner enrollment lock must be a private regular file')
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if not database.query('SELECT to_json(pg_try_advisory_lock(214716023,1));'):
            raise RuntimeError('Account lifecycle is busy')
        try:
            return _prepare(admin,database,manifest,journal,identity,source_identity,enable_private,username,timezone,layout)
        finally:
            try: database.query('SELECT to_json(pg_advisory_unlock(214716023,1));')
            except Exception: pass  # A closed session releases the lock; preserve the original failure.


def _prepare(admin, database, manifest, journal, identity, source_identity, enable_private, username, timezone, layout):
    if database.query('SELECT row_to_json(m) FROM gtd.schema_meta m;') != {
            'singleton':True,'compatibility':13,'environment':layout.environment,'identity':identity}:
        raise RuntimeError('Owner enrollment database does not match the destination')
    expected = {'format':1,'environment':layout.environment,'database_identity':identity,
        'source_identity':source_identity,'timezone':timezone,'issuer':manifest['issuer'],'realm':layout.realm,'username':username}
    if journal.exists() or journal.is_symlink():
        state = private_read(journal)
        if any(state.get(k) != v for k,v in expected.items()):
            raise RuntimeError('Owner journal belongs to a different migration')
    else:
        if database.query('SELECT to_json(count(*)) FROM gtd.accounts;') != 0:
            raise RuntimeError('Owner preparation cannot adopt an enrolled database')
        state = {**expected,'account_id':str(uuid.uuid4()),'generation':str(uuid.uuid4()),
            'state_identity':str(uuid.uuid4()),'password':'Gtd-9!'+secrets.token_urlsafe(32),'prepared':False}
        atomic_json(journal,state)
    for key in ('account_id','generation','state_identity'):
        if str(uuid.UUID(state[key])) != state[key]: raise RuntimeError('Invalid owner journal identity')
    if (type(state.get('prepared')) is not bool or not isinstance(state.get('password'),str)
            or not 40 <= len(state['password']) <= 512):
        raise RuntimeError('Invalid private owner enrollment state')
    if state.get('subject') is not None and str(uuid.UUID(state['subject'])) != state['subject']:
        raise RuntimeError('Invalid owner journal subject')
    prefix = '/admin/realms/'+layout.realm
    realm = admin.request(prefix)
    if (realm.get('attributes',{}).get('gtd_'+layout.environment+'_database') != identity
            or realm.get('registrationAllowed') is not False):
        raise RuntimeError('Owner provider realm differs from the configured deployment')
    attributes = {'gtd_account_id':[state['account_id']],'gtd_generation':[state['generation']]}
    users = admin.request(prefix+'/users?username='+username+'&exact=true')
    if not users:
        if state.get('subject') or state['prepared']:
            raise RuntimeError('The provisioned owner identity disappeared')
        admin.request(prefix+'/users','POST',{'username':username,'enabled':False,'attributes':attributes,
            'requiredActions':['UPDATE_PASSWORD'],
            'credentials':[{'type':'password','value':state['password'],'temporary':True}]})
        users = admin.request(prefix+'/users?username='+username+'&exact=true')
    if len(users) != 1 or users[0].get('username') != username:
        raise RuntimeError('Owner provider identity is ambiguous')
    user = admin.request(prefix+'/users/'+str(uuid.UUID(users[0]['id'])))
    if ((user.get('enabled') is not False and not (enable_private and user.get('enabled') is True))
            or user.get('username') != username
            or 'UPDATE_PASSWORD' not in user.get('requiredActions',[])
            or any(user.get('attributes',{}).get(k) != v for k,v in attributes.items())):
        raise RuntimeError('Refusing to adopt or reset a different or activated owner identity')
    subject = str(uuid.UUID(user['id']))
    if state.get('subject',subject) != subject:
        raise RuntimeError('Owner provider subject changed')
    state['subject'] = subject
    atomic_json(journal,state)
    binding = {'id':state['account_id'],'issuer':state['issuer'],'subject':subject,'username':username,
        'timezone':timezone,'administrator':True,'credential_generation':state['generation'],'enabled':True,'enrollment':'active'}
    columns = ','.join(binding)
    values = ','.join(str(v).lower() if type(v) is bool else literal(v) for v in binding.values())
    select_binding = ('SELECT coalesce((SELECT row_to_json(a) FROM (SELECT '+columns+
        ' FROM gtd.accounts WHERE id='+literal(state['account_id'])+") a),'null'::json);")
    database.query('BEGIN; SELECT to_json(true);')
    try:
        actual = database.query(select_binding)
        if actual is None:
            if state['prepared'] or database.query('SELECT to_json(count(*)) FROM gtd.accounts;') != 0:
                raise RuntimeError('Owner application mapping is missing or the database was enrolled separately')
            database.query('INSERT INTO gtd.accounts('+columns+') VALUES('+values+'); '
                'INSERT INTO gtd.account_state(account_id,identity) VALUES('+literal(state['account_id'])+','+literal(state['state_identity'])+'); '
                "INSERT INTO gtd.admin_events(target_id,event) VALUES("+literal(state['account_id'])+",'bound'); SELECT to_json(true);")
            actual = database.query(select_binding)
        history_identity = database.query('SELECT coalesce((SELECT to_json(identity) FROM gtd.account_state WHERE account_id='+literal(state['account_id'])+"),'null'::json);")
        if actual != binding or history_identity != state['state_identity']:
            raise RuntimeError('Owner application mapping differs from the immutable journal')
        database.query('COMMIT; SELECT to_json(true);')
    except BaseException:
        try: database.query('ROLLBACK; SELECT to_json(true);')
        except Exception: pass
        raise
    state['prepared'] = True
    atomic_json(journal,state)
    if enable_private:
        # Identity and generation were checked above against both stores. Never
        # reset credentials on replay, even after a lost provider PUT response.
        if user['enabled'] is False:
            admin.request(prefix+'/users/'+subject,'PUT',{'enabled':True})
        confirmed = admin.request(prefix+'/users/'+subject)
        if (confirmed.get('enabled') is not True or confirmed.get('username') != username
                or 'UPDATE_PASSWORD' not in confirmed.get('requiredActions',[])
                or any(confirmed.get('attributes',{}).get(k) != v for k,v in attributes.items())):
            raise RuntimeError('Private owner enablement did not preserve the prepared identity')
        state['provider_enabled_privately'] = True
        atomic_json(journal,state)
    return {**{k:state[k] for k in ('database_identity','source_identity','account_id','issuer','subject','username')},
        'administrator':True,'prepared':True,'provider_sign_in_enabled':enable_private,'passwords_printed':False}
