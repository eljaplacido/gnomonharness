#!/usr/bin/env python3
"""
A small AST mutation engine for Python, and the scoring rule that uses it.

WHY MUTATE THE AGENT'S CODE AND NOT A REFERENCE. The agent writes its own
implementation; a find/replace mutation of somebody else's reference cannot be
applied to it. These operators work on any Python module.

WHY A MUTANT MUST BE PROVEN DETECTABLE FIRST. An "equivalent mutant" -- one that
changes the syntax and not the behaviour -- is unkillable, and counting it as a
miss punishes a suite for something no suite could catch. So every mutant is
first run against the HIDDEN REFERENCE SUITE, which was written by hand before
any agent output existed. A mutant the reference suite does not kill is not
scorable and is discarded, and the count of discards is published.

The denominator is therefore "defects a known-good suite catches", which is the
question worth asking.
"""
import ast, subprocess, sys, os, tempfile, shutil


class _Mutator(ast.NodeTransformer):
    """Applies exactly the nth mutation opportunity it finds, then stops."""

    CMP_SWAP = {
        ast.Lt: ast.LtE, ast.LtE: ast.Lt,
        ast.Gt: ast.GtE, ast.GtE: ast.Gt,
        ast.Eq: ast.NotEq, ast.NotEq: ast.Eq,
    }
    BOOL_SWAP = {ast.And: ast.Or, ast.Or: ast.And}

    def __init__(self, target):
        self.target = target
        self.seen = -1
        self.applied = None

    def _hit(self, kind):
        self.seen += 1
        if self.seen == self.target:
            self.applied = kind
            return True
        return False

    def visit_Compare(self, node):
        self.generic_visit(node)
        if len(node.ops) == 1 and type(node.ops[0]) in self.CMP_SWAP:
            was = type(node.ops[0]).__name__
            if self._hit("compare:" + was):
                node.ops = [self.CMP_SWAP[type(node.ops[0])]()]
        return node

    def visit_BoolOp(self, node):
        self.generic_visit(node)
        if type(node.op) in self.BOOL_SWAP:
            if self._hit("boolop:" + type(node.op).__name__):
                node.op = self.BOOL_SWAP[type(node.op)]()
        return node

    def visit_Constant(self, node):
        if isinstance(node.value, bool):
            if self._hit("bool:" + str(node.value)):
                return ast.copy_location(ast.Constant(value=not node.value), node)
            return node
        if isinstance(node.value, int):
            if self._hit("int:" + str(node.value)):
                return ast.copy_location(ast.Constant(value=node.value + 1), node)
            return node
        if isinstance(node.value, str) and node.value != "":
            if self._hit("str"):
                return ast.copy_location(ast.Constant(value=node.value + "X"), node)
        return node

    def visit_If(self, node):
        self.generic_visit(node)
        # Removing a guard is the classic missing-precondition defect, and
        # guards are where the interesting behaviour lives.
        if self._hit("drop-guard"):
            return node.body if isinstance(node.body, list) else [node.body]
        return node

    def visit_AugAssign(self, node):
        self.generic_visit(node)
        if isinstance(node.op, (ast.Add, ast.Sub)):
            if self._hit("augassign:" + type(node.op).__name__):
                node.op = ast.Sub() if isinstance(node.op, ast.Add) else ast.Add()
        return node


def count_sites(src):
    n = 0
    while True:
        m = _Mutator(n)
        try:
            m.visit(ast.parse(src))
        except SyntaxError:
            return 0
        if m.applied is None:
            return n
        n += 1


def mutate(src, i):
    """Return (mutated_source, kind) for the i-th mutation site, or (None, None)."""
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return None, None
    m = _Mutator(i)
    tree = m.visit(tree)
    if m.applied is None:
        return None, None
    ast.fix_missing_locations(tree)
    try:
        return ast.unparse(tree), m.applied
    except Exception:
        return None, None


def run_pytest(workdir, testfile, timeout=60):
    """True if the suite PASSES. Failure, error and timeout are all False."""
    try:
        r = subprocess.run(
            [sys.executable, "-m", "pytest", "-q", "-x", "--no-header", testfile],
            cwd=workdir, capture_output=True, timeout=timeout,
        )
        return r.returncode == 0
    except subprocess.TimeoutExpired:
        # A mutant that hangs IS killed: an infinite loop is a defect the suite
        # surfaced, and calling it a survivor would flatter the suite.
        return False


def score_module(module_src, module_name, agent_test_src, hidden_test_src, max_mutants=40):
    """The pre-registered pipeline. Every number is read from a pytest exit code."""
    work = tempfile.mkdtemp(prefix="mut-")
    try:
        mod = os.path.join(work, module_name + ".py")
        open(mod, "w").write(module_src)
        open(os.path.join(work, "test_agent.py"), "w").write(agent_test_src or "")
        open(os.path.join(work, "test_hidden.py"), "w").write(hidden_test_src)

        baseline_agent = run_pytest(work, "test_agent.py") if agent_test_src else False
        baseline_hidden = run_pytest(work, "test_hidden.py")

        sites = count_sites(module_src)
        killed = scorable = unscorable = 0
        rows = []
        for i in range(min(sites, max_mutants)):
            mutated, kind = mutate(module_src, i)
            if mutated is None:
                continue
            open(mod, "w").write(mutated)
            try:
                if run_pytest(work, "test_hidden.py"):
                    # The reference suite cannot see this change: equivalent, or
                    # outside what the specification pins. Not the agent's fault.
                    unscorable += 1
                    rows.append({"site": i, "kind": kind, "scorable": False})
                    continue
                scorable += 1
                agent_ok = run_pytest(work, "test_agent.py") if agent_test_src else True
                if not agent_ok:
                    killed += 1
                rows.append({"site": i, "kind": kind, "scorable": True, "killed": not agent_ok})
            finally:
                open(mod, "w").write(module_src)

        return {
            "module": module_name,
            "agent_tests_pass_on_agent_code": baseline_agent,
            "hidden_suite_passes_on_agent_code": baseline_hidden,
            "mutation_sites": sites,
            "scorable_mutants": scorable,
            "unscorable_mutants": unscorable,
            "killed": killed,
            "mutation_score": round(killed / scorable, 4) if scorable else None,
            "mutants": rows,
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)
