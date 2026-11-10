"""Read-only environment preflight shared by synthetic mutation scripts."""
import json
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def test_origin(value):
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname
            or parsed.username or parsed.password or parsed.path not in ("", "/")
            or parsed.query or parsed.fragment):
        raise ValueError("Use an explicit HTTP(S) test origin without credentials, a path, query, or fragment")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def require_test_environment(origin, opener=None, headers=None):
    origin = test_origin(origin)
    opener = opener or urllib.request.build_opener(NoRedirect())
    request = urllib.request.Request(origin + "/api/health", headers=headers or {})
    try:
        with opener.open(request, timeout=10) as response:
            health = json.load(response)
    except (OSError, ValueError) as error:
        raise RuntimeError("Refusing synthetic mutations: test-mode health could not be verified (redirects are not accepted)") from error
    if not isinstance(health, dict) or health.get("environment") != "test":
        raise RuntimeError("Refusing synthetic mutations: /api/health must report environment=test")
    return health


def sign_in_test_site(origin, opener, username, password):
    """Refuse production before sending a synthetic tester's login request."""
    origin = test_origin(origin)
    with opener.open(origin + "/api/auth/session", timeout=10) as response:
        status = json.load(response)
    if not isinstance(status, dict) or status.get("environment") != "test":
        raise RuntimeError("Refusing test login: session endpoint must report environment=test")
    request = urllib.request.Request(origin + "/api/auth/login", data=json.dumps({
        "username": username, "password": password, "remember": False,
    }).encode(), headers={"Content-Type": "application/json", "Origin": origin, "X-GTD-Request": "1"})
    with opener.open(request, timeout=30) as response:
        if json.load(response).get("authenticated") is not True:
            raise RuntimeError("Test-site login failed")
