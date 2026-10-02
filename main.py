"""一条本地命令启动: python3 main.py [--port 8000] [--no-seed]

自动建库、写入虚构演示数据(含换导师案例)、启动进程内提醒线程与 Web 服务。
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.db import init_db
from app.reminders import ReminderScheduler
from app.seed import seed
from app.web import serve


def main() -> None:
    ap = argparse.ArgumentParser(description="企业导师配对系统")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-seed", action="store_true", help="不重建演示数据")
    ap.add_argument("--fresh", action="store_true",
                    help="重置数据库并重新写入演示数据(默认首次启动即如此)")
    args = ap.parse_args()

    from app.db import DB_PATH
    if args.no_seed:
        init_db()
    elif args.fresh or not DB_PATH.exists():
        seed(fresh=args.fresh)
    else:
        init_db()

    scheduler = ReminderScheduler(interval_seconds=60)
    scheduler.start()
    print("⏰ 进程内提醒任务已启动（每 60 秒扫描长期未开始的计划）")
    print("👤 演示入口: http://%s:%d/login （员工可看「林一帆」的待配对流程，"
          "主管可审批「褚琳」的换导师案例）" % (args.host, args.port))
    try:
        serve(args.host, args.port)
    except KeyboardInterrupt:
        scheduler.stop()


if __name__ == "__main__":
    main()
