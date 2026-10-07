"""手机版测试入口。

一次跑完两套测试：
  1. test_phone.js   —— 业务逻辑（计价 / 库存 / 撤销 / 场次 / 备份 / 弹窗结构）
  2. test_handoff.js —— 数据导入验收（用 tests/_handoff/ 中的样例档案核对账目）

用法：
    python run_tests.py              # 只看结果汇总
    python run_tests.py --verbose    # 显示每一项测试的明细

需要 Node.js（用于在沙箱中运行业务逻辑，无需浏览器）。
"""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TESTS = [("test_phone.js", "业务逻辑"), ("test_handoff.js", "数据导入验收")]


def run(script: str, verbose: bool) -> tuple[bool, str]:
    """跑一个测试脚本，返回 (是否通过, 最后一行摘要)。"""
    try:
        result = subprocess.run(
            ["node", str(ROOT / "tests" / script)],
            cwd=str(ROOT), text=True, encoding="utf-8", errors="replace",
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
    except FileNotFoundError:
        return False, "无法执行 node"

    output = result.stdout or ""
    if verbose:
        print(output)

    # 取最后一行非空输出作为摘要（脚本自己会打印「全部通过：N 项测试」这类结论）
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return result.returncode == 0, (lines[-1] if lines else "")


def main() -> int:
    verbose = "--verbose" in sys.argv or "-v" in sys.argv

    if shutil.which("node") is None:
        print("未找到 Node.js。")
        print("本项目使用 Node 在沙箱中运行业务逻辑测试（不需要浏览器）。")
        print("安装方式：https://nodejs.org/")
        return 1

    print(f"运行 {len(TESTS)} 套测试\n")
    passed, failed = 0, 0
    for script, label in TESTS:
        ok, summary = run(script, verbose)
        mark = "PASS" if ok else "FAIL"
        print(f"  [{mark}] {label:<10} {script:<18} {summary}")
        if ok:
            passed += 1
        else:
            failed += 1

    # 清理测试临时目录
    tmp = ROOT / "tests" / "_tmp"
    if tmp.exists():
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if failed:
        print(f"{passed} 套通过，{failed} 套失败。加 --verbose 查看明细。")
        return 1
    print(f"全部 {passed} 套测试通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
