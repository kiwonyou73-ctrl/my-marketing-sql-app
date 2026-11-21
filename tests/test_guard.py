"""lib/sql_guard.py 를 tests/guard_cases.json 의 사례로 시험한다.

    python tests/test_guard.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "lib"))

from sql_guard import check  # noqa: E402


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    cases = json.loads((ROOT / "tests" / "guard_cases.json").read_text(encoding="utf-8"))
    failed = 0
    for c in cases:
        ok, reason = check(c["sql"])
        good = ok == c["allow"]
        failed += not good
        verdict = "통과" if ok else f"차단({reason})"
        print(f"{'OK  ' if good else 'FAIL'} {c['name']:<32} 기대={'통과' if c['allow'] else '차단'} 실제={verdict}")
    print(f"\n{len(cases) - failed}/{len(cases)} 사례 일치")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
