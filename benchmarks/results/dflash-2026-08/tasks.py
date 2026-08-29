"""Verifiable coding tasks for the DFlash on/off wall-clock experiment.

Each task: a fixture (files written into a fresh workspace), a prompt gnomon
solves, and a `verify` shell command run in that workspace (exit 0 == pass).
Ordered roughly fast -> slow so the wall-clock spread exercises the speed delta.
"""

TASKS = [
    {
        "name": "square",
        "files": {"sample.py": "hello = 'world'\n"},
        "prompt": "Add a function square(x) that returns x*x to sample.py. Keep the existing hello variable.",
        "verify": "python3 -c \"import sample; assert sample.square(4)==16; assert sample.hello=='world'\"",
    },
    {
        "name": "fixbug",
        "files": {"calc.py": "def add(a, b):\n    return a - b\n"},
        "prompt": "There is a bug in calc.py: add() subtracts instead of adding. Fix it so add returns the sum.",
        "verify": "python3 -c \"import calc; assert calc.add(2,3)==5; assert calc.add(10,5)==15\"",
    },
    {
        "name": "palindrome",
        "files": {"strutil.py": "# implement is_palindrome below\n"},
        "prompt": "Implement is_palindrome(s) in strutil.py: return True if s reads the same forwards and backwards, ignoring case and any non-alphanumeric characters.",
        "verify": "python3 -c \"import strutil as s; assert s.is_palindrome('A man, a plan, a canal: Panama'); assert not s.is_palindrome('hello'); assert s.is_palindrome('')\"",
    },
    {
        "name": "refactor",
        "files": {
            "a.py": "def compute(x):\n    return x * 2\n",
            "b.py": "from a import compute\n\nprint(compute(5))\n",
        },
        "prompt": "Rename the function compute to double_it everywhere it is defined and used, across a.py and b.py. The program must still print 10.",
        "verify": "grep -q 'def double_it' a.py && grep -q 'double_it(5)' b.py && ! grep -q 'compute' a.py && ! grep -q 'compute' b.py && [ \"$(python3 b.py)\" = 10 ]",
    },
    {
        "name": "failtest",
        "files": {
            "mymath.py": "def factorial(n):\n    return n\n",
            "test_mymath.py": "from mymath import factorial\n\n\ndef test_factorial():\n    assert factorial(0) == 1\n    assert factorial(5) == 120\n    assert factorial(1) == 1\n",
        },
        "prompt": "The test in test_mymath.py fails because factorial in mymath.py is wrong. Fix mymath.py so the test passes. Run pytest to confirm it is green.",
        "verify": "python3 -m pytest -q test_mymath.py >/dev/null 2>&1",
    },
    {
        "name": "cliflag",
        "files": {
            "wc.py": "import sys\n\n\ndef main():\n    path = sys.argv[1]\n    print(open(path).read())\n\n\nif __name__ == '__main__':\n    main()\n",
        },
        "prompt": "Add a --lines flag to wc.py so that `python3 wc.py --lines <file>` prints only the number of lines in the file (an integer). Without the flag, keep the existing behaviour of printing the file contents.",
        "verify": "printf 'a\\nb\\nc\\n' > t.txt && [ \"$(python3 wc.py --lines t.txt)\" = 3 ] && python3 wc.py t.txt | grep -q a",
    },
]


TASKS += [
    {
        "name": "citydata",
        "files": {"data.py": "# CITIES data below\n"},
        "prompt": "Create data.py containing a Python list named CITIES with exactly 30 dictionaries. Each dictionary must have the keys name, country, and population (an int). Use real, plausible major world cities and values. Just write the file, no other code.",
        "verify": "python3 -c \"import data; assert isinstance(data.CITIES,list) and len(data.CITIES)==30; assert all(set(c)>={'name','country','population'} and isinstance(c['population'],int) for c in data.CITIES)\"",
    },
    {
        "name": "mathlib",
        "files": {"mathlib.py": "# implement the functions below\n"},
        "prompt": "Create mathlib.py with these 12 functions, each with a one-line docstring: is_even(n), is_odd(n), factorial(n), fib(n) (0-indexed, fib(0)=0, fib(1)=1), gcd(a,b), lcm(a,b), is_prime(n), sum_to(n) meaning 1+2+...+n, reverse_string(s), count_vowels(s), clamp(x,lo,hi), and mean(xs). Write the whole file.",
        "verify": "python3 -c \"import mathlib as m; assert m.is_even(4) and not m.is_odd(4); assert m.factorial(5)==120; assert m.fib(7)==13; assert m.gcd(12,8)==4; assert m.lcm(4,6)==12; assert m.is_prime(13) and not m.is_prime(9); assert m.sum_to(5)==15; assert m.reverse_string('abc')=='cba'; assert m.count_vowels('hello')==2; assert m.clamp(9,0,5)==5; assert m.mean([2,4,6])==4\"",
    },
    {
        "name": "fizzbuzz_suite",
        "files": {"fb.py": "# implement below\n"},
        "prompt": "Create fb.py with a function classify(n) returning 'FizzBuzz' if n divisible by 15, 'Fizz' if by 3, 'Buzz' if by 5, else str(n); and run(lo, hi) returning the list of classify(n) for n from lo to hi inclusive, returning [] when lo>hi. Add docstrings.",
        "verify": "python3 -c \"import fb; assert fb.classify(15)=='FizzBuzz'; assert fb.classify(9)=='Fizz'; assert fb.classify(10)=='Buzz'; assert fb.classify(7)=='7'; assert fb.run(1,5)==['1','2','Fizz','4','Buzz']; assert fb.run(5,1)==[]\"",
    },
]
