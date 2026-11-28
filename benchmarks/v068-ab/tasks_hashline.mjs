// E-HASHLINE benchmark task set: 10 non-saturating brownfield multi-hunk tasks
// (8 Python, 2 Node ESM). Designed to exercise `edit_format = "hashline"` vs
// `"str_replace"` under repeated boilerplate, indentation sensitivity, and
// multi-file coordinated edits.
//
// Each task ships a small in-workspace smoke test plus an external hidden test
// suite held outside the workspace and executed by the runner after the turn.

export const HASHLINE_TASKS = [
  {
    id: "dup-handlers",
    lang: "python",
    prompt:
      "Fix all four defects in router.py:\n" +
      "1. handle_create must reject empty 'name' with status 422 (currently returns 400) and default role to 'member' when omitted.\n" +
      "2. handle_update must require auth role 'admin' or 'editor' (currently rejects 'editor' with 403) and preserve existing 'created_at'.\n" +
      "3. handle_delete must require auth role 'admin' (currently allows 'editor') and mark deleted=True instead of popping the key.\n" +
      "4. handle_archive must return 409 if the record is already archived, and must NOT mutate 'updated_by' when returning 409.\n" +
      "Run `python3 -m unittest test_smoke.py` to check your changes.",
    files: {
      "router.py": `class Context:
    def __init__(self, user=None, role=None, store=None):
        self.user = user
        self.role = role
        self.store = store if store is not None else {}


def handle_create(ctx, payload):
    if not ctx.user:
        return {"status": 401, "error": "unauthorized"}
    if not isinstance(payload, dict):
        return {"status": 400, "error": "invalid payload"}
    item_id = payload.get("id")
    if not item_id:
        return {"status": 400, "error": "missing id"}
    if item_id in ctx.store:
        return {"status": 409, "error": "exists"}
    name = (payload.get("name") or "").strip()
    if not name:
        return {"status": 400, "error": "missing name"}
    role = payload.get("role") or "guest"
    rec = {
        "id": item_id,
        "name": name,
        "role": role,
        "created_at": payload.get("ts", 0),
        "updated_by": ctx.user,
        "archived": False,
        "deleted": False,
    }
    ctx.store[item_id] = rec
    return {"status": 201, "data": rec}


def handle_update(ctx, payload):
    if not ctx.user:
        return {"status": 401, "error": "unauthorized"}
    if not isinstance(payload, dict):
        return {"status": 400, "error": "invalid payload"}
    item_id = payload.get("id")
    if not item_id:
        return {"status": 400, "error": "missing id"}
    if ctx.role != "admin":
        return {"status": 403, "error": "forbidden"}
    rec = ctx.store.get(item_id)
    if rec is None or rec.get("deleted"):
        return {"status": 404, "error": "not found"}
    new_rec = dict(rec)
    if "name" in payload:
        new_rec["name"] = payload["name"]
    if "role" in payload:
        new_rec["role"] = payload["role"]
    new_rec["created_at"] = payload.get("ts", 0)
    new_rec["updated_by"] = ctx.user
    ctx.store[item_id] = new_rec
    return {"status": 200, "data": new_rec}


def handle_delete(ctx, payload):
    if not ctx.user:
        return {"status": 401, "error": "unauthorized"}
    if not isinstance(payload, dict):
        return {"status": 400, "error": "invalid payload"}
    item_id = payload.get("id")
    if not item_id:
        return {"status": 400, "error": "missing id"}
    if ctx.role not in ("admin", "editor"):
        return {"status": 403, "error": "forbidden"}
    rec = ctx.store.get(item_id)
    if rec is None or rec.get("deleted"):
        return {"status": 404, "error": "not found"}
    ctx.store.pop(item_id)
    return {"status": 200, "deleted": item_id}


def handle_archive(ctx, payload):
    if not ctx.user:
        return {"status": 401, "error": "unauthorized"}
    if not isinstance(payload, dict):
        return {"status": 400, "error": "invalid payload"}
    item_id = payload.get("id")
    if not item_id:
        return {"status": 400, "error": "missing id"}
    if ctx.role not in ("admin", "editor"):
        return {"status": 403, "error": "forbidden"}
    rec = ctx.store.get(item_id)
    if rec is None or rec.get("deleted"):
        return {"status": 404, "error": "not found"}
    rec["updated_by"] = ctx.user
    if rec.get("archived"):
        return {"status": 200, "data": rec}
    rec["archived"] = True
    return {"status": 200, "data": rec}
`,
      "test_smoke.py": `import unittest
from router import Context, handle_create

class Smoke(unittest.TestCase):
    def test_create_ok(self):
        ctx = Context(user="alice", role="admin")
        res = handle_create(ctx, {"id": "1", "name": "Alpha", "ts": 100})
        self.assertEqual(res["status"], 201)
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.py",
      cmd: ["python3", "__hidden_eval__.py"],
      content: `import sys
from router import Context, handle_create, handle_update, handle_delete, handle_archive

checks = []
def run_check(name, fn):
    try:
        checks.append((name, bool(fn())))
    except Exception:
        checks.append((name, False))

def t1():
    c = Context("alice", "admin")
    return handle_create(c, {"id": "1", "name": "   "})["status"] == 422

def t2():
    c = Context("alice", "admin")
    r = handle_create(c, {"id": "1", "name": "Alpha", "ts": 123})
    return r["status"] == 201 and r["data"]["role"] == "member"

def t3():
    c = Context("alice", "admin")
    handle_create(c, {"id": "1", "name": "Alpha", "ts": 123})
    c_ed = Context("bob", "editor", c.store)
    r = handle_update(c_ed, {"id": "1", "name": "Beta", "ts": 999})
    return r["status"] == 200 and r["data"]["name"] == "Beta"

def t4():
    c = Context("alice", "admin")
    handle_create(c, {"id": "1", "name": "Alpha", "ts": 123})
    c_ed = Context("bob", "editor", c.store)
    r = handle_update(c_ed, {"id": "1", "name": "Beta", "ts": 999})
    return r["status"] == 200 and r["data"]["created_at"] == 123 and r["data"]["updated_by"] == "bob"

def t5():
    c = Context("alice", "admin")
    handle_create(c, {"id": "1", "name": "Alpha", "ts": 123})
    c_ed = Context("bob", "editor", c.store)
    r = handle_delete(c_ed, {"id": "1"})
    return r["status"] == 403 and "1" in c.store

def t6():
    c = Context("alice", "admin")
    handle_create(c, {"id": "1", "name": "Alpha", "ts": 123})
    r = handle_delete(c, {"id": "1"})
    return r["status"] == 200 and "1" in c.store and c.store["1"]["deleted"] is True

def t7():
    c = Context("alice", "admin")
    handle_create(c, {"id": "2", "name": "Gamma", "ts": 50})
    r1 = handle_archive(c, {"id": "2"})
    return r1["status"] == 200 and c.store["2"]["archived"] is True

def t8():
    c = Context("alice", "admin")
    handle_create(c, {"id": "2", "name": "Gamma", "ts": 50})
    handle_archive(c, {"id": "2"})
    c_ed = Context("bob", "editor", c.store)
    r2 = handle_archive(c_ed, {"id": "2"})
    return r2["status"] == 409 and c.store["2"]["updated_by"] == "alice"

for n, f in [("create_empty_422", t1), ("create_default_role", t2), ("update_editor_ok", t3),
             ("update_preserves_created_at", t4), ("delete_denies_editor", t5), ("delete_soft", t6),
             ("archive_first_ok", t7), ("archive_second_409_nomut", t8)]:
    run_check(n, f)

passed = sum(1 for _, ok in checks if ok)
print(f"PASS={passed}/{len(checks)}")
for name, ok in checks:
    if not ok:
        print(f"FAIL:{name}")
sys.exit(0 if passed == len(checks) else 1)
`,
    },
  },

  {
    id: "repeated-guards",
    lang: "python",
    prompt:
      "Fix the tenant isolation and rate-limit bugs in guards.py:\n" +
      "1. check_read, check_write, and check_export all enforce tenant isolation, but check_write and check_export forget to reject mismatched tenant_id (return (False, 'tenant_mismatch')). Leave check_health and check_metrics tenant-agnostic.\n" +
      "2. RateLimiter.allow(key, now) must bucket by (tenant_id, key) when tenant_id is passed via allow(key, now, tenant_id=None) — default None keeps backward compatibility.\n" +
      "3. check_export must also enforce rate_limiter.allow('export', now, tenant_id=req.tenant_id) and return (False, 'rate_limited') when exceeded.\n" +
      "Run `python3 -m unittest test_smoke.py` to check.",
    files: {
      "guards.py": `class Request:
    def __init__(self, user, tenant_id, resource_tenant, role="viewer"):
        self.user = user
        self.tenant_id = tenant_id
        self.resource_tenant = resource_tenant
        self.role = role


class RateLimiter:
    def __init__(self, limit, window_s):
        self.limit = limit
        self.window_s = window_s
        self._hits = {}

    def allow(self, key, now):
        bucket = self._hits.setdefault(key, [])
        cutoff = now - self.window_s
        bucket = [t for t in bucket if t > cutoff]
        if len(bucket) >= self.limit:
            self._hits[key] = bucket
            return False
        bucket.append(now)
        self._hits[key] = bucket
        return True


def check_health(req):
    if not req.user:
        return (False, "no_user")
    return (True, "ok")


def check_metrics(req):
    if not req.user:
        return (False, "no_user")
    if req.role not in ("admin", "ops"):
        return (False, "forbidden")
    return (True, "ok")


def check_read(req):
    if not req.user:
        return (False, "no_user")
    if req.tenant_id != req.resource_tenant:
        return (False, "tenant_mismatch")
    return (True, "ok")


def check_write(req):
    if not req.user:
        return (False, "no_user")
    if req.role not in ("admin", "editor"):
        return (False, "forbidden")
    return (True, "ok")


def check_export(req, rate_limiter, now):
    if not req.user:
        return (False, "no_user")
    if req.role not in ("admin", "editor"):
        return (False, "forbidden")
    if not rate_limiter.allow("export", now):
        return (False, "rate_limited")
    return (True, "ok")
`,
      "test_smoke.py": `import unittest
from guards import Request, RateLimiter, check_read, check_health

class Smoke(unittest.TestCase):
    def test_read(self):
        self.assertEqual(check_read(Request("u", "t1", "t1")), (True, "ok"))
        self.assertEqual(check_read(Request("u", "t1", "t2")), (False, "tenant_mismatch"))
    def test_health(self):
        self.assertEqual(check_health(Request("u", "t1", "t2")), (True, "ok"))
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.py",
      cmd: ["python3", "__hidden_eval__.py"],
      content: `import sys
from guards import Request, RateLimiter, check_health, check_metrics, check_read, check_write, check_export

checks = []
def check(name, cond):
    checks.append((name, bool(cond)))

check("health_cross_tenant", check_health(Request("u", "t1", "t2")) == (True, "ok"))
check("metrics_cross_tenant", check_metrics(Request("u", "t1", "t2", "ops")) == (True, "ok"))
check("write_tenant_mismatch", check_write(Request("u", "t1", "t2", "admin")) == (False, "tenant_mismatch"))
check("write_same_tenant_ok", check_write(Request("u", "t1", "t1", "editor")) == (True, "ok"))

rl = RateLimiter(limit=1, window_s=60)
check("export_tenant_mismatch", check_export(Request("u", "t1", "t2", "admin"), rl, 10) == (False, "tenant_mismatch"))
# mismatch should not consume t1's quota
check("export_t1_first", check_export(Request("u", "t1", "t1", "admin"), rl, 11) == (True, "ok"))
check("export_t1_second_limited", check_export(Request("u", "t1", "t1", "admin"), rl, 12) == (False, "rate_limited"))
# t2 has separate bucket!
check("export_t2_independent", check_export(Request("u", "t2", "t2", "admin"), rl, 12) == (True, "ok"))
# backward compat allow(key, now)
rl2 = RateLimiter(limit=1, window_s=10)
check("rl_compat", rl2.allow("k", 1) is True and rl2.allow("k", 2) is False)

passed = sum(1 for _, ok in checks if ok)
print(f"PASS={passed}/{len(checks)}")
for name, ok in checks:
    if not ok:
        print(f"FAIL:{name}")
sys.exit(0 if passed == len(checks) else 1)
`,
    },
  },

  {
    id: "multi-file-rename",
    lang: "python",
    prompt:
      "Refactor the billing package across models.py, store.py, and service.py:\n" +
      "1. Rename AccountRecord.cents -> AccountRecord.balance_cents and add optional currency='USD' field (included in to_dict() and from_dict()).\n" +
      "2. Update Store.credit(account_id, amount_cents) and Store.debit(account_id, amount_cents) so debit refuses overdrafts (raising ValueError('insufficient funds')) and credit rejects amount_cents <= 0 (raising ValueError).\n" +
      "3. Update BillingService.transfer(src_id, dst_id, amount_cents) to reject cross-currency transfers (raising ValueError('currency mismatch')) and ensure atomicity (if destination is missing, source balance is unchanged).\n" +
      "Run `python3 -m unittest test_smoke.py` to verify.",
    files: {
      "models.py": `from dataclasses import dataclass

@dataclass
class AccountRecord:
    account_id: str
    owner: str
    cents: int = 0

    def to_dict(self):
        return {
            "account_id": self.account_id,
            "owner": self.owner,
            "cents": self.cents,
        }

    @classmethod
    def from_dict(cls, data):
        return cls(
            account_id=data["account_id"],
            owner=data["owner"],
            cents=int(data.get("cents", 0)),
        )
`,
      "store.py": `from models import AccountRecord

class Store:
    def __init__(self):
        self._accounts = {}

    def create(self, account_id, owner, initial_cents=0, currency="USD"):
        if account_id in self._accounts:
            raise ValueError("account exists")
        rec = AccountRecord(account_id=account_id, owner=owner, cents=initial_cents)
        self._accounts[account_id] = rec
        return rec

    def get(self, account_id):
        if account_id not in self._accounts:
            raise KeyError(account_id)
        return self._accounts[account_id]

    def credit(self, account_id, amount_cents):
        rec = self.get(account_id)
        rec.cents += amount_cents
        return rec.cents

    def debit(self, account_id, amount_cents):
        rec = self.get(account_id)
        rec.cents -= amount_cents
        return rec.cents
`,
      "service.py": `class BillingService:
    def __init__(self, store):
        self.store = store

    def transfer(self, src_id, dst_id, amount_cents):
        if amount_cents <= 0:
            raise ValueError("amount must be positive")
        self.store.debit(src_id, amount_cents)
        self.store.credit(dst_id, amount_cents)
        return (self.store.get(src_id).cents, self.store.get(dst_id).cents)

    def snapshot(self, account_id):
        return self.store.get(account_id).to_dict()
`,
      "test_smoke.py": `import unittest
from store import Store
from service import BillingService

class Smoke(unittest.TestCase):
    def test_create_and_transfer(self):
        s = Store()
        s.create("a", "Alice", 500)
        s.create("b", "Bob", 100)
        svc = BillingService(s)
        self.assertEqual(svc.transfer("a", "b", 200), (300, 300))
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.py",
      cmd: ["python3", "__hidden_eval__.py"],
      content: `import sys
from models import AccountRecord
from store import Store
from service import BillingService

checks = []
def run_check(name, fn):
    try:
        checks.append((name, bool(fn())))
    except Exception:
        checks.append((name, False))

def t1():
    r = AccountRecord("a1", "Alice", 1000, "EUR")
    d = r.to_dict()
    r2 = AccountRecord.from_dict(d)
    return r.balance_cents == 1000 and d["balance_cents"] == 1000 and d["currency"] == "EUR" and r2.balance_cents == 1000 and r2.currency == "EUR"

def t2():
    return AccountRecord("a2", "Bob").currency == "USD"

def t3():
    s = Store()
    s.create("b", "Bob", 100, "USD")
    try:
        s.debit("b", 200)
        return False
    except ValueError:
        return getattr(s.get("b"), "balance_cents", None) == 100

def t4():
    s = Store()
    s.create("b", "Bob", 100, "USD")
    try:
        s.credit("b", 0)
        return False
    except ValueError:
        return True

def t5():
    s = Store()
    s.create("a", "Alice", 500, "USD")
    s.create("e", "Eve", 100, "EUR")
    svc = BillingService(s)
    try:
        svc.transfer("a", "e", 50)
        return False
    except ValueError:
        return s.get("a").balance_cents == 500 and s.get("e").balance_cents == 100

def t6():
    s = Store()
    s.create("a", "Alice", 500, "USD")
    svc = BillingService(s)
    try:
        svc.transfer("a", "missing", 50)
        return False
    except KeyError:
        return s.get("a").balance_cents == 500

def t7():
    s = Store()
    s.create("a", "Alice", 500, "USD")
    s.create("b", "Bob", 100, "USD")
    svc = BillingService(s)
    return svc.transfer("a", "b", 200) == (300, 300) and svc.snapshot("a")["balance_cents"] == 300

for n, f in [("model_fields_and_serde", t1), ("model_default_currency", t2), ("debit_overdraft_raises", t3),
             ("credit_nonpos_raises", t4), ("cross_currency_raises", t5), ("atomic_missing_dst", t6), ("transfer_ok", t7)]:
    run_check(n, f)

passed = sum(1 for _, ok in checks if ok)
print(f"PASS={passed}/{len(checks)}")
for name, ok in checks:
    if not ok:
        print(f"FAIL:{name}")
sys.exit(0 if passed == len(checks) else 1)
`,
    },
  },

  {
    id: "whitespace-table",
    lang: "python",
    prompt:
      "Fix the three bugs in tablefmt.py:\n" +
      "1. parse_table() currently strips internal spaces inside cells via ' '.join(cell.split()) — it should ONLY strip leading/trailing whitespace on each cell, preserving internal spaces and escaped pipes ('\\\\|' becomes '|').\n" +
      "2. format_table(headers, rows, align=None) must support right alignment ('>') and center alignment ('^') in addition to left ('<'), and emit separator dashes matching column width (using ':---', '---:', ':---:' for align markers when markdown=True).\n" +
      "3. format_table() must escape literal '|' in cell values as '\\\\|' when markdown=True, and must not add trailing spaces after the closing '|'.\n" +
      "Run `python3 -m unittest test_smoke.py` to check.",
    files: {
      "tablefmt.py": `def _split_row(line):
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [" ".join(part.split()) for part in line.split("|")]


def parse_table(text):
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if len(lines) < 2:
        return [], []
    headers = _split_row(lines[0])
    # Skip separator line if it looks like --- / :---
    start = 1
    sep_cells = _split_row(lines[1])
    if all(c and set(c) <= {"-", ":"} for c in sep_cells):
        start = 2
    rows = [_split_row(ln) for ln in lines[start:]]
    return headers, rows


def _pad(text, width, align):
    return text.ljust(width)


def _sep_cell(width, align, markdown):
    return "-" * max(3, width)


def format_table(headers, rows, align=None, markdown=True):
    ncols = len(headers)
    aligns = list(align) if align else ["<"] * ncols
    str_headers = [str(h) for h in headers]
    str_rows = [[str(c) for c in r] for r in rows]

    widths = [len(h) for h in str_headers]
    for r in str_rows:
        for i, c in enumerate(r):
            if i < ncols and len(c) > widths[i]:
                widths[i] = len(c)
    widths = [max(3, w) for w in widths]

    def render_row(cells):
        parts = [_pad(cells[i] if i < len(cells) else "", widths[i], aligns[i]) for i in range(ncols)]
        return "| " + " | ".join(parts) + " | "

    out = [render_row(str_headers)]
    sep = [_sep_cell(widths[i], aligns[i], markdown) for i in range(ncols)]
    out.append("| " + " | ".join(sep) + " |")
    for r in str_rows:
        out.append(render_row(r))
    return "\\n".join(out)
`,
      "test_smoke.py": `import unittest
from tablefmt import parse_table, format_table

class Smoke(unittest.TestCase):
    def test_roundtrip_simple(self):
        txt = format_table(["Name", "Qty"], [["Apple", 3]])
        h, rows = parse_table(txt)
        self.assertEqual(h, ["Name", "Qty"])
        self.assertEqual(rows, [["Apple", "3"]])
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.py",
      cmd: ["python3", "__hidden_eval__.py"],
      content: `import sys
from tablefmt import parse_table, format_table

checks = []
def check(name, cond):
    checks.append((name, bool(cond)))

# 1. preserve internal spaces & escaped pipes
raw = "| Name | Note |\\n| --- | --- |\\n| A  B | x \\\\| y |"
h, rows = parse_table(raw)
check("preserve_internal_spaces", rows == [["A  B", "x | y"]])

# 2. no trailing whitespace
out = format_table(["Item", "Val"], [["ok", 7]], align=["<", ">"], markdown=True)
lines = out.splitlines()
check("no_trailing_space", all(not ln.endswith(" ") for ln in lines))

# 3. right alignment padding & separator
check("right_align_cell", "|   7 |" in lines[2])
check("right_align_sep", lines[1].endswith("---: |"))

# 4. center alignment
out_c = format_table(["Col"], [["x"]], align=["^"], markdown=True)
clines = out_c.splitlines()
check("center_align_cell", "|  x  |" in clines[2] or "| x  |" in clines[2] or "|  x |" in clines[2])
check("center_align_sep", ":" in clines[1] and clines[1].strip().startswith("| :") and clines[1].strip().endswith(": |"))

# 5. pipe escaping in markdown=True and roundtrip
out_p = format_table(["Expr"], [["a | b"]], markdown=True)
check("escape_pipe", "a \\\\| b" in out_p)
_, r2 = parse_table(out_p)
check("roundtrip_pipe", r2 == [["a | b"]])

passed = sum(1 for _, ok in checks if ok)
print(f"PASS={passed}/{len(checks)}")
for name, ok in checks:
    if not ok:
        print(f"FAIL:{name}")
sys.exit(0 if passed == len(checks) else 1)
`,
    },
  },

  {
    id: "state-machine-transitions",
    lang: "python",
    prompt:
      "Fix the four workflow bugs in orders.py:\n" +
      "1. cancel() must be allowed from both 'draft' and 'paid' (currently blocks 'paid'), and must NOT be allowed from 'shipped' or 'delivered' (raise TransitionError).\n" +
      "2. refund() must only be allowed from 'delivered' or 'cancelled' when was_paid is True (currently allows refunding an unpaid cancelled draft!).\n" +
      "3. Calling ship() twice with the same tracking_id must be idempotent (return False without appending a duplicate history entry), while a different tracking_id raises TransitionError.\n" +
      "4. Every successful transition must record (from_state, to_state, actor) in order.history (currently pay() records (to_state, from_state, actor) backwards).\n" +
      "Run `python3 -m unittest test_smoke.py` to check.",
    files: {
      "orders.py": `class TransitionError(ValueError):
    pass


class Order:
    def __init__(self, order_id):
        self.order_id = order_id
        self.state = "draft"
        self.was_paid = False
        self.tracking_id = None
        self.history = []

    def pay(self, actor="system"):
        if self.state != "draft":
            raise TransitionError(f"cannot pay from {self.state}")
        prev = self.state
        self.state = "paid"
        self.was_paid = True
        self.history.append((self.state, prev, actor))
        return True

    def ship(self, tracking_id, actor="warehouse"):
        if self.state != "paid":
            raise TransitionError(f"cannot ship from {self.state}")
        prev = self.state
        self.state = "shipped"
        self.tracking_id = tracking_id
        self.history.append((prev, self.state, actor))
        return True

    def deliver(self, actor="carrier"):
        if self.state != "shipped":
            raise TransitionError(f"cannot deliver from {self.state}")
        prev = self.state
        self.state = "delivered"
        self.history.append((prev, self.state, actor))
        return True

    def cancel(self, actor="user"):
        if self.state != "draft":
            raise TransitionError(f"cannot cancel from {self.state}")
        prev = self.state
        self.state = "cancelled"
        self.history.append((prev, self.state, actor))
        return True

    def refund(self, actor="billing"):
        if self.state not in ("delivered", "cancelled"):
            raise TransitionError(f"cannot refund from {self.state}")
        prev = self.state
        self.state = "refunded"
        self.history.append((prev, self.state, actor))
        return True
`,
      "test_smoke.py": `import unittest
from orders import Order

class Smoke(unittest.TestCase):
    def test_happy_path(self):
        o = Order("o1")
        o.pay("alice")
        o.ship("TRK-1")
        o.deliver()
        self.assertEqual(o.state, "delivered")
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.py",
      cmd: ["python3", "__hidden_eval__.py"],
      content: `import sys
from orders import Order, TransitionError

checks = []
def run_check(name, fn):
    try:
        checks.append((name, bool(fn())))
    except Exception:
        checks.append((name, False))

def t1():
    o = Order("o1"); o.pay("alice")
    return o.history == [("draft", "paid", "alice")]

def t2():
    o = Order("o1"); o.pay("alice"); o.cancel("alice")
    return o.state == "cancelled"

def t3():
    o = Order("o1"); o.pay("alice"); o.cancel("alice"); o.refund("fin")
    return o.state == "refunded" and o.history[-1] == ("cancelled", "refunded", "fin")

def t4():
    o = Order("o2"); o.cancel("alice")
    try:
        o.refund("fin"); return False
    except TransitionError:
        return o.state == "cancelled"

def t5():
    o = Order("o3"); o.pay("bob")
    r1 = o.ship("TRK-9", "w1")
    r2 = o.ship("TRK-9", "w1")
    return r1 is True and r2 is False and len(o.history) == 2

def t6():
    o = Order("o3"); o.pay("bob"); o.ship("TRK-9", "w1")
    try:
        o.ship("TRK-OTHER", "w2"); return False
    except TransitionError:
        return o.tracking_id == "TRK-9"

def t7():
    o = Order("o3"); o.pay("bob"); o.ship("TRK-9", "w1")
    try:
        o.cancel("bob"); return False
    except TransitionError:
        return True

def t8():
    o = Order("o3"); o.pay("bob"); o.ship("TRK-9", "w1"); o.deliver()
    try:
        o.cancel("bob"); return False
    except TransitionError:
        return True

for n, f in [("pay_history_order", t1), ("cancel_from_paid", t2), ("refund_paid_cancelled", t3),
             ("no_refund_unpaid", t4), ("ship_idempotent", t5), ("ship_diff_tracking_raises", t6),
             ("no_cancel_shipped", t7), ("no_cancel_delivered", t8)]:
    run_check(n, f)

passed = sum(1 for _, ok in checks if ok)
print(f"PASS={passed}/{len(checks)}")
for name, ok in checks:
    if not ok:
        print(f"FAIL:{name}")
sys.exit(0 if passed == len(checks) else 1)
`,
    },
  },

  {
    id: "config-parser-edge",
    lang: "python",
    prompt:
      "Fix the four edge-case bugs in miniconf.py:\n" +
      "1. Inline '#' comments must NOT strip '#' inside double-quoted strings (e.g. color = \"#ff00aa\" # primary -> '#ff00aa').\n" +
      "2. Escaped quotes (\\\\\") and escaped newlines (\\\\n) inside double-quoted values must be unescaped properly.\n" +
      "3. Dotted section headers like [server.tls] must create nested dicts {'server': {'tls': {...}}} instead of flat key 'server.tls'.\n" +
      "4. Duplicate keys within the same section must raise ConfigError instead of silently overwriting.\n" +
      "Run `python3 -m unittest test_smoke.py` to check.",
    files: {
      "miniconf.py": `class ConfigError(ValueError):
    pass


def _strip_comment(line):
    if "#" in line:
        line = line.split("#", 1)[0]
    return line.strip()


def _parse_value(raw):
    raw = raw.strip()
    if raw.startswith('"') and raw.endswith('"') and len(raw) >= 2:
        return raw[1:-1]
    if raw == "true":
        return True
    if raw == "false":
        return False
    if raw.lstrip("-").isdigit():
        return int(raw)
    return raw


def parse_config(text):
    root = {}
    current = root
    for lineno, orig in enumerate(text.splitlines(), 1):
        line = _strip_comment(orig)
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            sec = line[1:-1].strip()
            if not sec:
                raise ConfigError(f"line {lineno}: empty section")
            current = root.setdefault(sec, {})
            continue
        if "=" not in line:
            raise ConfigError(f"line {lineno}: expected key = value")
        key, val = line.split("=", 1)
        key = key.strip()
        if not key:
            raise ConfigError(f"line {lineno}: empty key")
        current[key] = _parse_value(val)
    return root
`,
      "test_smoke.py": `import unittest
from miniconf import parse_config

class Smoke(unittest.TestCase):
    def test_basic(self):
        cfg = parse_config('[app]\\nport = 8080\\ndebug = true\\n')
        self.assertEqual(cfg["app"]["port"], 8080)
        self.assertTrue(cfg["app"]["debug"])
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.py",
      cmd: ["python3", "__hidden_eval__.py"],
      content: `import sys
from miniconf import parse_config, ConfigError

checks = []
def run_check(name, fn):
    try:
        checks.append((name, bool(fn())))
    except Exception:
        checks.append((name, False))

run_check("hash_in_quotes", lambda: parse_config('color = "#ff00aa" # primary\\n').get("color") == "#ff00aa")
run_check("escapes", lambda: parse_config(r'msg = "say \\"hi\\"\\nbye" # comment' + '\\n').get("msg") == 'say "hi"\\nbye')
run_check("nested_sections", lambda: (lambda c: c.get("server", {}).get("tls", {}).get("enabled") is True and c.get("server", {}).get("host") == "127.0.0.1")(parse_config('[server.tls]\\nenabled = true\\ncert = "/etc/cert.pem"\\n[server]\\nhost = "127.0.0.1"\\n')))

def t_dup():
    try:
        parse_config('[a]\\nx = 1\\nx = 2\\n')
        return False
    except ConfigError:
        return True
run_check("dup_key_raises", t_dup)
run_check("diff_section_same_key_ok", lambda: (lambda c: c["a"]["x"] == 1 and c["b"]["x"] == 2)(parse_config('[a]\\nx = 1\\n[b]\\nx = 2\\n')))
run_check("types_preserved", lambda: (lambda c: c["offset"] == -5 and c["flag"] is False)(parse_config('offset = -5\\nflag = false\\n')))

passed = sum(1 for _, ok in checks if ok)
print(f"PASS={passed}/{len(checks)}")
for name, ok in checks:
    if not ok:
        print(f"FAIL:{name}")
sys.exit(0 if passed == len(checks) else 1)
`,
    },
  },

  {
    id: "js-esm-refactor",
    lang: "node",
    prompt:
      "Fix the four bugs across cache.mjs and client.mjs:\n" +
      "1. TtlLruCache.get(key, now) in cache.mjs must refresh LRU recency on a cache hit (currently leaves hit key at old position so it gets evicted first).\n" +
      "2. TtlLruCache.set(key, val, ttlMs, now) must treat an expired entry as evicted and must NOT evict a live entry when updating an existing key.\n" +
      "3. TtlLruCache must distinguish missing vs cached `undefined`/`null` values (negative caching): add has(key, now) and return `{ hit: true, value }` or `{ hit: false }` from lookup(key, now).\n" +
      "4. CachedClient.fetch(key, now) in client.mjs must use lookup() so a cached `null` result is returned as a cache hit without calling the loader again.\n" +
      "Run `node --test smoke.test.mjs` to check.",
    files: {
      "cache.mjs": `export class TtlLruCache {
  constructor(maxSize = 4) {
    this.maxSize = maxSize;
    this._map = new Map();
  }

  get(key, now = Date.now()) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (now >= entry.expiresAt) {
      this._map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs, now = Date.now()) {
    if (this._map.size >= this.maxSize) {
      const oldestKey = this._map.keys().next().value;
      this._map.delete(oldestKey);
    }
    this._map.set(key, { value, expiresAt: now + ttlMs });
  }

  size() {
    return this._map.size;
  }
}
`,
      "client.mjs": `export class CachedClient {
  constructor(cache, loader, ttlMs = 1000) {
    this.cache = cache;
    this.loader = loader;
    this.ttlMs = ttlMs;
    this.loads = 0;
  }

  fetch(key, now = Date.now()) {
    const cached = this.cache.get(key, now);
    if (cached !== undefined && cached !== null) {
      return cached;
    }
    this.loads += 1;
    const val = this.loader(key);
    this.cache.set(key, val, this.ttlMs, now);
    return val;
  }
}
`,
      "smoke.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { TtlLruCache } from "./cache.mjs";
import { CachedClient } from "./client.mjs";

test("basic cache hit", () => {
  const c = new TtlLruCache(2);
  const cli = new CachedClient(c, (k) => "v:" + k, 100);
  assert.equal(cli.fetch("a", 0), "v:a");
  assert.equal(cli.fetch("a", 50), "v:a");
  assert.equal(cli.loads, 1);
});
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.mjs",
      cmd: ["node", "__hidden_eval__.mjs"],
      content: `import { TtlLruCache } from "./cache.mjs";
import { CachedClient } from "./client.mjs";

const checks = [];
const runCheck = (name, fn) => {
  try { checks.push([name, Boolean(fn())]); } catch { checks.push([name, false]); }
};

runCheck("lru_refresh_on_get", () => {
  const c1 = new TtlLruCache(2);
  c1.set("a", 1, 1000, 0);
  c1.set("b", 2, 1000, 1);
  c1.get("a", 2);
  c1.set("c", 3, 1000, 3);
  return c1.get("a", 4) === 1 && c1.get("b", 4) === undefined && c1.get("c", 4) === 3;
});

runCheck("update_no_evict", () => {
  const c2 = new TtlLruCache(2);
  c2.set("a", 1, 1000, 0);
  c2.set("b", 2, 1000, 1);
  c2.set("a", 10, 1000, 2);
  return c2.get("a", 3) === 10 && c2.get("b", 3) === 2 && c2.size() === 2;
});

runCheck("expired_purged_first", () => {
  const c3 = new TtlLruCache(2);
  c3.set("a", 1, 10, 0);
  c3.set("b", 2, 1000, 1);
  c3.set("c", 3, 1000, 20);
  return c3.get("b", 21) === 2 && c3.get("c", 21) === 3;
});

runCheck("lookup_null_hit", () => {
  const c4 = new TtlLruCache(2);
  c4.set("nil", null, 100, 0);
  const lk = c4.lookup("nil", 50);
  return lk && lk.hit === true && lk.value === null && c4.has("nil", 50) === true;
});

runCheck("lookup_expired_miss", () => {
  const c4 = new TtlLruCache(2);
  c4.set("nil", null, 100, 0);
  const lkMiss = c4.lookup("nil", 150);
  return lkMiss && lkMiss.hit === false && c4.has("nil", 150) === false;
});

runCheck("client_negative_cache", () => {
  const c5 = new TtlLruCache(4);
  const cli = new CachedClient(c5, () => null, 100);
  const v1 = cli.fetch("missing", 0);
  const v2 = cli.fetch("missing", 50);
  return v1 === null && v2 === null && cli.loads === 1;
});

runCheck("client_negative_expires", () => {
  const c5 = new TtlLruCache(4);
  const cli = new CachedClient(c5, () => null, 100);
  cli.fetch("missing", 0);
  const v3 = cli.fetch("missing", 150);
  return v3 === null && cli.loads === 2;
});

const passed = checks.filter(([, ok]) => ok).length;
console.log(\`PASS=\${passed}/\${checks.length}\`);
for (const [n, ok] of checks) if (!ok) console.log(\`FAIL:\${n}\`);
process.exit(passed === checks.length ? 0 : 1);
`,
    },
  },

  {
    id: "sql-query-builder",
    lang: "python",
    prompt:
      "Fix the four bugs in builder.py:\n" +
      "1. quote_ident() must reject invalid identifiers containing ';' or whitespace with ValueError, and quote dotted identifiers segment-by-segment (e.g. 'u.name' -> '\"u\".\"name\"').\n" +
      "2. where_in(col, values) must produce '1 = 0' when values is empty (instead of invalid SQL 'IN ()') and append each value to params.\n" +
      "3. offset(n) without limit(m) must raise ValueError on build(), and negative limit/offset must raise ValueError immediately.\n" +
      "4. build() must return a fresh copy of params (not a reference to internal list) and preserve parameter order when joins have parameters before WHERE clauses.\n" +
      "Run `python3 -m unittest test_smoke.py` to check.",
    files: {
      "builder.py": `import re


def quote_ident(name):
    if not name or not isinstance(name, str):
        raise ValueError("empty identifier")
    return f'"{name}"'


class QueryBuilder:
    def __init__(self, table):
        self._table = quote_ident(table)
        self._cols = ["*"]
        self._joins = []
        self._join_params = []
        self._wheres = []
        self._where_params = []
        self._orders = []
        self._limit = None
        self._offset = None

    def select(self, *cols):
        self._cols = [quote_ident(c) for c in cols] if cols else ["*"]
        return self

    def join(self, table, on_sql, *params):
        self._joins.append(f"JOIN {quote_ident(table)} ON {on_sql}")
        self._join_params.extend(params)
        return self

    def where(self, col, op, val):
        self._wheres.append(f"{quote_ident(col)} {op} ?")
        self._where_params.append(val)
        return self

    def where_in(self, col, values):
        placeholders = ", ".join(["?"] * len(values))
        self._wheres.append(f"{quote_ident(col)} IN ({placeholders})")
        self._where_params.extend(values)
        return self

    def order_by(self, col, desc=False):
        direction = "DESC" if desc else "ASC"
        self._orders.append(f"{quote_ident(col)} {direction}")
        return self

    def limit(self, n):
        self._limit = int(n)
        return self

    def offset(self, n):
        self._offset = int(n)
        return self

    def build(self):
        parts = [f"SELECT {', '.join(self._cols)} FROM {self._table}"]
        if self._joins:
            parts.extend(self._joins)
        if self._wheres:
            parts.append("WHERE " + " AND ".join(self._wheres))
        if self._orders:
            parts.append("ORDER BY " + ", ".join(self._orders))
        if self._limit is not None:
            parts.append(f"LIMIT {self._limit}")
        if self._offset is not None:
            parts.append(f"OFFSET {self._offset}")
        params = self._where_params
        if self._join_params:
            params.extend(self._join_params)
        return " ".join(parts), params
`,
      "test_smoke.py": `import unittest
from builder import QueryBuilder

class Smoke(unittest.TestCase):
    def test_simple(self):
        sql, params = QueryBuilder("users").select("id").where("active", "=", 1).build()
        self.assertIn('FROM "users"', sql)
        self.assertEqual(params, [1])
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.py",
      cmd: ["python3", "__hidden_eval__.py"],
      content: `import sys
from builder import QueryBuilder, quote_ident

checks = []
def check(name, cond):
    checks.append((name, bool(cond)))

# 1. dotted ident & injection rejection
check("dotted_ident", quote_ident("u.name") == '"u"."name"')
try:
    quote_ident("users; DROP TABLE x")
    check("reject_bad_ident", False)
except ValueError:
    check("reject_bad_ident", True)

# 2. empty where_in -> 1 = 0
sql, params = QueryBuilder("items").where_in("id", []).build()
check("empty_where_in", "1 = 0" in sql and "IN ()" not in sql and params == [])

# 3. negative limit/offset and offset without limit
try:
    QueryBuilder("items").limit(-1)
    check("neg_limit_raises", False)
except ValueError:
    check("neg_limit_raises", True)

try:
    QueryBuilder("items").offset(10).build()
    check("offset_without_limit_raises", False)
except ValueError:
    check("offset_without_limit_raises", True)

# 4. join params precede where params & build returns fresh list
qb = QueryBuilder("orders").join("users", "users.id = orders.uid AND users.org = ?", "acme").where("orders.total", ">", 100)
sql1, p1 = qb.build()
p1.append("MUTATED")
sql2, p2 = qb.build()
check("join_param_order", p2 == ["acme", 100])
check("fresh_params_copy", p2 == ["acme", 100] and len(p2) == 2)

passed = sum(1 for _, ok in checks if ok)
print(f"PASS={passed}/{len(checks)}")
for name, ok in checks:
    if not ok:
        print(f"FAIL:{name}")
sys.exit(0 if passed == len(checks) else 1)
`,
    },
  },

  {
    id: "ledger-rounding",
    lang: "python",
    prompt:
      "Fix the four accounting bugs across currency.py and ledger.py:\n" +
      "1. quantize_money() in currency.py must use ROUND_HALF_EVEN (banker's rounding) and support 0-decimal currencies ('JPY', 'KRW') in addition to 2-decimal currencies.\n" +
      "2. allocate(amount, weights, currency='USD') in currency.py must distribute the exact amount across weights so the parts sum to the exact quantized amount, giving any remainder units (+0.01 or +1 for JPY) one-by-one to the earliest buckets with the largest fractional remainder.\n" +
      "3. Ledger.post(entries) in ledger.py must enforce double-entry balance PER currency (each currency's entries must sum to Decimal('0')), raising ValueError if any currency is unbalanced.\n" +
      "4. Ledger.balance(account, currency) must return quantized Decimal('0.00') (or Decimal('0') for JPY) when an account has no entries.\n" +
      "Run `python3 -m unittest test_smoke.py` to check.",
    files: {
      "currency.py": `from decimal import Decimal, ROUND_HALF_UP

ZERO_DECIMAL = {"JPY", "KRW"}


def exponent_for(currency):
    return Decimal("1") if currency in ZERO_DECIMAL else Decimal("0.01")


def quantize_money(value, currency="USD"):
    d = Decimal(str(value))
    return d.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def allocate(amount, weights, currency="USD"):
    if not weights or sum(weights) <= 0:
        raise ValueError("weights must be positive")
    total = quantize_money(amount, currency)
    wsum = Decimal(str(sum(weights)))
    return [quantize_money(total * Decimal(str(w)) / wsum, currency) for w in weights]
`,
      "ledger.py": `from decimal import Decimal
from currency import quantize_money


class Ledger:
    def __init__(self):
        self.transactions = []

    def post(self, entries):
        if not entries:
            raise ValueError("empty transaction")
        total = sum(Decimal(str(e["amount"])) for e in entries)
        if total != Decimal("0"):
            raise ValueError("unbalanced transaction")
        normalized = [
            {
                "account": e["account"],
                "currency": e.get("currency", "USD"),
                "amount": quantize_money(e["amount"], e.get("currency", "USD")),
            }
            for e in entries
        ]
        self.transactions.append(normalized)

    def balance(self, account, currency="USD"):
        total = Decimal("0")
        for tx in self.transactions:
            for e in tx:
                if e["account"] == account and e["currency"] == currency:
                    total += e["amount"]
        return total
`,
      "test_smoke.py": `import unittest
from decimal import Decimal
from ledger import Ledger

class Smoke(unittest.TestCase):
    def test_post(self):
        l = Ledger()
        l.post([{"account": "cash", "amount": "10.00"}, {"account": "rev", "amount": "-10.00"}])
        self.assertEqual(l.balance("cash"), Decimal("10.00"))
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.py",
      cmd: ["python3", "__hidden_eval__.py"],
      content: `import sys
from decimal import Decimal
from currency import quantize_money, allocate
from ledger import Ledger

checks = []
def check(name, cond):
    checks.append((name, bool(cond)))

# 1. banker's rounding + JPY 0-decimal
check("round_half_even_even", quantize_money("2.345", "USD") == Decimal("2.34"))
check("round_half_even_odd", quantize_money("2.355", "USD") == Decimal("2.36"))
check("jpy_zero_dec", str(quantize_money("100.5", "JPY")) == "100")

# 2. allocate sums exactly
parts = allocate("1.00", [1, 1, 1], "USD")
check("alloc_usd_sum", sum(parts) == Decimal("1.00") and sorted(parts) == [Decimal("0.33"), Decimal("0.33"), Decimal("0.34")])
parts_w = allocate("0.10", [1, 2, 7], "USD")
check("alloc_exact_weights", parts_w == [Decimal("0.01"), Decimal("0.02"), Decimal("0.07")])
parts_jpy = allocate("100", [1, 1, 1], "JPY")
check("alloc_jpy_sum", sum(parts_jpy) == Decimal("100") and parts_jpy == [Decimal("34"), Decimal("33"), Decimal("33")])

# 3. per-currency double entry check
l = Ledger()
try:
    l.post([
        {"account": "a", "currency": "USD", "amount": "10.00"},
        {"account": "b", "currency": "EUR", "amount": "-10.00"},
    ])
    check("per_currency_reject", False)
except ValueError:
    check("per_currency_reject", True)

# 4. quantized zero balance for empty account
check("zero_balance_usd", str(l.balance("nobody", "USD")) == "0.00")
check("zero_balance_jpy", str(l.balance("nobody", "JPY")) == "0")

passed = sum(1 for _, ok in checks if ok)
print(f"PASS={passed}/{len(checks)}")
for name, ok in checks:
    if not ok:
        print(f"FAIL:{name}")
sys.exit(0 if passed == len(checks) else 1)
`,
    },
  },

  {
    id: "csv-stream-escape",
    lang: "python",
    prompt:
      "Fix the four RFC-4180 bugs in csv_stream.py:\n" +
      "1. parse_csv() must handle doubled quotes (\"\" -> \") inside quoted fields AND embedded newlines inside quoted fields.\n" +
      "2. parse_csv() must handle CRLF (\\r\\n) row endings without leaving trailing '\\r' in the last field.\n" +
      "3. format_csv() must quote any field containing the delimiter, '\"', '\\n', or '\\r', doubling internal quotes.\n" +
      "4. parse_csv() must raise ValueError('unterminated quote') when a quoted field reaches EOF without a closing quote.\n" +
      "Run `python3 -m unittest test_smoke.py` to check.",
    files: {
      "csv_stream.py": `def parse_csv(text, delimiter=","):
    rows = []
    if not text:
        return rows
    for line in text.split("\\n"):
        if line == "":
            continue
        fields = []
        buf = []
        in_quotes = False
        for ch in line:
            if ch == '"':
                in_quotes = not in_quotes
            elif ch == delimiter and not in_quotes:
                fields.append("".join(buf))
                buf = []
            else:
                buf.append(ch)
        fields.append("".join(buf))
        rows.append(fields)
    return rows


def format_csv(rows, delimiter=","):
    out = []
    for row in rows:
        cells = []
        for val in row:
            s = str(val)
            if delimiter in s:
                s = f'"{s}"'
            cells.append(s)
        out.append(delimiter.join(cells))
    return "\\r\\n".join(out) + ("\\r\\n" if out else "")
`,
      "test_smoke.py": `import unittest
from csv_stream import parse_csv, format_csv

class Smoke(unittest.TestCase):
    def test_simple(self):
        self.assertEqual(parse_csv("a,b\\n1,2\\n"), [["a", "b"], ["1", "2"]])
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.py",
      cmd: ["python3", "__hidden_eval__.py"],
      content: `import sys
from csv_stream import parse_csv, format_csv

checks = []
def check(name, cond):
    checks.append((name, bool(cond)))

# 1. doubled quotes inside quoted field
r1 = parse_csv('a,"he said ""hi""",c\\n')
check("doubled_quotes", r1 == [["a", 'he said "hi"', "c"]])

# 2. embedded newline inside quoted field
r2 = parse_csv('id,note\\n1,"line1\\nline2"\\n2,ok\\n')
check("embedded_newline", r2 == [["id", "note"], ["1", "line1\\nline2"], ["2", "ok"]])

# 3. CRLF handling
r3 = parse_csv('a,b\\r\\n1,2\\r\\n')
check("crlf_clean", r3 == [["a", "b"], ["1", "2"]])

# 4. format_csv quotes delimiter, quote, newline
s = format_csv([["x", 'say "ok"', "a,b", "m\\nn"]])
check("format_quotes_all", '"say ""ok"""' in s and '"a,b"' in s and '"m\\nn"' in s)
check("roundtrip_complex", parse_csv(s) == [["x", 'say "ok"', "a,b", "m\\nn"]])

# 5. unterminated quote raises ValueError
try:
    parse_csv('a,"unterminated\\n')
    check("unterminated_raises", False)
except ValueError:
    check("unterminated_raises", True)

passed = sum(1 for _, ok in checks if ok)
print(f"PASS={passed}/{len(checks)}")
for name, ok in checks:
    if not ok:
        print(f"FAIL:{name}")
sys.exit(0 if passed == len(checks) else 1)
`,
    },
  },

  {
    id: "js-event-bus",
    lang: "node",
    prompt:
      "Fix the four bugs in bus.mjs:\n" +
      "1. once(event, fn) must unregister itself BEFORE invoking fn so re-entrant emit() inside fn does not trigger fn a second time, and off(event, fn) must also cancel a pending once() listener.\n" +
      "2. emit(event, payload) must snapshot the listener list before iterating so listeners that call off() during emit() do not skip the next listener.\n" +
      "3. Wildcard namespace subscriptions like 'order.*' must match 'order.created' and 'order.paid' (single segment after prefix), NOT 'order' or 'order.a.b'.\n" +
      "4. If a listener throws, emit() must still invoke remaining listeners and return `{ delivered, errors }` where `errors` is the array of thrown Error objects.\n" +
      "Run `node --test smoke.test.mjs` to check.",
    files: {
      "bus.mjs": `export class EventBus {
  constructor() {
    this._listeners = new Map();
  }

  on(event, fn) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }
    this._listeners.get(event).push(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const wrapper = (payload) => {
      fn(payload);
      this.off(event, wrapper);
    };
    return this.on(event, wrapper);
  }

  off(event, fn) {
    const arr = this._listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
  }

  emit(event, payload) {
    const arr = this._listeners.get(event) || [];
    let delivered = 0;
    const errors = [];
    for (const fn of arr) {
      fn(payload);
      delivered += 1;
    }
    return { delivered, errors };
  }
}
`,
      "smoke.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "./bus.mjs";

test("basic on/emit", () => {
  const b = new EventBus();
  const seen = [];
  b.on("ping", (x) => seen.push(x));
  const res = b.emit("ping", 42);
  assert.deepEqual(seen, [42]);
  assert.equal(res.delivered, 1);
});
`,
    },
    hiddenTest: {
      filename: "__hidden_eval__.mjs",
      cmd: ["node", "__hidden_eval__.mjs"],
      content: `import { EventBus } from "./bus.mjs";

const checks = [];
const runCheck = (name, fn) => {
  try { checks.push([name, Boolean(fn())]); } catch { checks.push([name, false]); }
};

runCheck("once_reentrant", () => {
  const b1 = new EventBus();
  let count = 0;
  b1.once("tick", () => {
    count += 1;
    if (count < 5) b1.emit("tick", null);
  });
  b1.emit("tick", null);
  return count === 1;
});

runCheck("off_cancels_once", () => {
  const b2 = new EventBus();
  let fired = false;
  const h = () => { fired = true; };
  b2.once("ev", h);
  b2.off("ev", h);
  b2.emit("ev", null);
  return fired === false;
});

runCheck("snapshot_iteration", () => {
  const b3 = new EventBus();
  const order = [];
  const first = () => { order.push("first"); b3.off("x", first); };
  const second = () => { order.push("second"); };
  b3.on("x", first);
  b3.on("x", second);
  b3.emit("x", null);
  return order.length === 2 && order[0] === "first" && order[1] === "second";
});

runCheck("wildcard_single_segment", () => {
  const b4 = new EventBus();
  const wild = [];
  b4.on("order.*", (p) => wild.push(p));
  b4.emit("order.created", 1);
  b4.emit("order.paid", 2);
  b4.emit("order", 3);
  b4.emit("order.a.b", 4);
  return wild.length === 2 && wild[0] === 1 && wild[1] === 2;
});

runCheck("error_isolation", () => {
  const b5 = new EventBus();
  const seen = [];
  b5.on("e", () => { throw new Error("boom"); });
  b5.on("e", (v) => seen.push(v));
  const r = b5.emit("e", "ok");
  return seen.length === 1 && seen[0] === "ok" && r.delivered === 1 && r.errors.length === 1 && r.errors[0].message === "boom";
});

const passed = checks.filter(([, ok]) => ok).length;
console.log(\`PASS=\${passed}/\${checks.length}\`);
for (const [n, ok] of checks) if (!ok) console.log(\`FAIL:\${n}\`);
process.exit(passed === checks.length ? 0 : 1);
`,
    },
  },
];
