import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import gtd
import recover
import upgrade

class Operations(unittest.TestCase):
 def test_recovery_invalidates_sessions_but_not_authoritative_content(self):
  class Database:
   def __init__(self):self.statements=[]
   def query(self,sql):
    self.statements.append(sql)
    if 'row_to_json' in sql:return {'identity':'fixture-id','environment':'staging','compatibility':13}
  db=Database();recover.invalidate_application(db,'fixture-id','staging')
  sql=' '.join(db.statements)
  self.assertIn('DELETE FROM gtd.web_sessions',sql)
  self.assertIn('account_state SET identity=gen_random_uuid()',sql)
  for table in ('tasks','changes','requests','revisions','action_groups'):
   self.assertNotIn('DELETE FROM gtd.'+table,sql)
  with self.assertRaises(ValueError):recover.invalidate_application(db,'foreign','staging')
  self.assertTrue(db.statements[-1].startswith('ROLLBACK'))

 def test_upgrade_requires_fresh_bound_backup_before_stopping_anything(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);(root/'operator').mkdir()
   for receipt in ({'database_identity':'foreign','verified_at':time.time()},
                   {'database_identity':'expected','verified_at':time.time()-3601}):
    gtd.atomic_json(root/'operator/verified-backup.json',receipt)
    with patch.object(gtd,'compose') as compose,self.assertRaises(ValueError):
     upgrade.switch(root,{'database_identity':'expected'},gtd.STAGING,{})
    compose.assert_not_called()

 def test_upgrade_rejects_mutable_image_tags(self):
  with patch.object(gtd,'run') as run:
   for image in ('latest','gtd-service:latest','sha256:bad'):
    with self.assertRaises(ValueError):upgrade.image(image)
   run.assert_not_called()

 def test_start_readiness_and_port_probe_use_loopback_only(self):
  with tempfile.TemporaryDirectory() as temp:
   with patch.object(gtd,'compose',return_value=''),patch.object(gtd.socket,'socket') as socket:
    socket.return_value.__enter__.return_value.connect_ex.return_value=0
    with self.assertRaises(ValueError):gtd.ensure_ports(gtd.STAGING,Path(temp))
    self.assertEqual(socket.return_value.__enter__.return_value.connect_ex.call_args.args[0][0],'127.0.0.1')

 def test_caddy_matchers_do_not_collide_on_shared_subdomain(self):
  first=gtd.mcp_route('mcp.one.example.com',1000,[]).splitlines()[0]
  second=gtd.mcp_route('mcp.two.example.com',1000,[]).splitlines()[0]
  self.assertNotEqual(first.split()[0],second.split()[0])

if __name__=='__main__':unittest.main()
