#!/usr/bin/env python3
"""端到端走查 (需先启动: python3 main.py --fresh --port 8123)。

六个交付页面 + 配对/部分时段冲突/跨部门回避/私密字段权限/
作者身份绑定/换导师/结项/离职改派/长期未开始提醒。
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("MENTOR_DB_PATH",
                      os.path.join(os.path.dirname(os.path.dirname(__file__)),
                                   "data", "mentor.db"))
from app.db import get_conn  # noqa: E402

BASE = "http://127.0.0.1:8123"
PASS = FAIL = 0


def check(cond, name):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("✅", name)
    else:
        FAIL += 1
        print("❌", name)


class Client:
    def __init__(self):
        self.op = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(CookieJar()))

    def login(self, uid):
        self.op.open(f"{BASE}/login",
                     data=urllib.parse.urlencode({"uid": uid}).encode())

    def get(self, path):
        return self.op.open(f"{BASE}{path}").read().decode()

    def post(self, path, data):
        req = urllib.request.Request(
            f"{BASE}{path}",
            data=urllib.parse.urlencode(data).encode(),
            method="POST")
        try:
            r = self.op.open(req)
            return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()


def scalar(sql, *args):
    conn = get_conn()
    try:
        return conn.execute(sql, args).fetchone()[0]
    finally:
        conn.close()


def main():
    c = Client()
    conn = get_conn()
    ids = {r["name"]: r["id"] for r in conn.execute(
        "SELECT id,name FROM users")}
    r6 = conn.execute(
        "SELECT id FROM match_requests WHERE status='OPEN' AND skill='Python 后端'"
    ).fetchone()["id"]
    r7 = conn.execute(
        "SELECT id FROM match_requests WHERE status='OPEN' AND skill='数据分析'"
    ).fetchone()["id"]
    conn.close()

    print("── 1. 导师目录: 擅长领域 + 剩余名额")
    c.login(ids["林一帆"])
    p = c.get("/")
    check("剩余名额" in p and "Python 后端" in p, "目录展示擅长领域与剩余名额")

    print("── 2. 配对 + 部分时段冲突: 林一帆(r6)→张伟")
    c.login(ids["王敏"])
    code, _ = c.post("/match", {"request_id": r6, "mentor_id": ids["张伟"]})
    check(code in (200,303), "配对成功(部分时段冲突放行)")
    new_pid = scalar("SELECT id FROM plans WHERE request_id=?", r6)
    c.login(ids["林一帆"])
    code, _ = c.post("/plan/accept", {"plan_id": new_pid})
    check(code in (200,303), "员工确认时段开始")
    slots = get_conn().execute(
        "SELECT weekday,period FROM schedule_slots WHERE plan_id=? AND active=1",
        (new_pid,)).fetchall()
    check([(s["weekday"], s["period"]) for s in slots] == [(3, "12:30-13:00")],
          "只落定无冲突的周三时段")

    print("── 3. 跨部门回避: 沈静(r7,人事部)→孙悦(市场部,不接跨部门)")
    c.login(ids["王敏"])
    code, body = c.post("/match", {"request_id": r7, "mentor_id": ids["孙悦"]})
    check(code == 400 and "CROSS_DEPT" in body, "跨部门回避拦截配对")

    print("── 4. 私密字段权限 (计划 #1)")
    c.login(ids["林一帆"])
    body = c.get("/plan?id=1")
    check("阶段性印象" not in body and "对你不可见" in body,
          "无关员工看不到私密反馈且页面隔离提示")
    c.login(ids["苏婷"])
    check("阶段性印象" in c.get("/plan?id=1"), "当事员工可见私密反馈")
    c.login(ids["王敏"])
    check("阶段性印象" in c.get("/plan?id=1"), "授权主管(工程部)可见")
    c.login(ids["陈立"])
    check("阶段性印象" not in c.get("/plan?id=1"), "外部门主管不可见")
    denied = scalar(
        "SELECT COUNT(*) FROM access_log WHERE allowed=0 AND action='VIEW_PRIVATE_FEEDBACK'")
    check(denied >= 2, "越权查看写入访问审计")

    print("── 5. 作者身份绑定: 张伟无法替员工提交反馈")
    c.login(ids["张伟"])
    code, _ = c.post("/plan/journal",
                     {"plan_id": 1, "kind": "feedback_private",
                      "title": "E2E导师反馈", "content": "x"})
    check(code in (200,303), "导师提交私密反馈成功")
    role = scalar("SELECT author_role FROM journal_entries WHERE title='E2E导师反馈'")
    check(role == "mentor", "作者角色由登录态强制为 mentor")

    print("── 6. 换导师案例: 褚琳(计划#3,人事部) → 李娜(工程部,接受跨部门)")
    # 先验证跨部门主管无权(申请仍 PENDING 时返回 FORBIDDEN), 再由人事部主管审批
    tr = scalar("SELECT id FROM transfer_requests WHERE plan_id=3 AND status='PENDING'")
    c.login(ids["王敏"])
    code, _ = c.post("/review/transfer",
                     {"transfer_id": tr, "decision": "approve",
                      "new_mentor_id": ids["李娜"]})
    check(code == 403, "跨部门主管(王敏)无权审批人事部辅导")
    c.login(ids["周慧"])
    code, body = c.post("/review/transfer",
                        {"transfer_id": tr, "decision": "approve",
                         "new_mentor_id": ids["李娜"]})
    check(code in (200,303), "人事部主管批准换导师")
    check(scalar("SELECT status FROM plans WHERE id=3") == "ABANDONED",
          "旧计划废弃并释放名额")
    check(scalar("SELECT status FROM plans WHERE predecessor_plan_id=3") == "PENDING",
          "生成新的待开始计划")
    check(scalar("SELECT COUNT(*) FROM schedule_slots WHERE plan_id=3 AND active=1") == 0,
          "旧时段释放")

    print("── 7. 提前结项审核: 计划 #4 (工程部辅导, 由王敏审批)")
    c.login(ids["王敏"])
    cr = scalar("SELECT id FROM completion_requests WHERE plan_id=4 AND status='PENDING'")
    code, _ = c.post("/review/completion",
                     {"completion_id": cr, "decision": "approve"})
    check(code in (200,303) and scalar("SELECT status FROM plans WHERE id=4") == "COMPLETED",
          "批准后计划结项")
    # 结项后写纪要被拒绝
    c.login(ids["卫晨"])
    code, _ = c.post("/plan/journal",
                     {"plan_id": 4, "kind": "goal", "title": "x", "content": "y"})
    check(code == 400, "结项后不能再写纪要")

    print("── 8. 导师离职: 郑强 → 自动改派")
    c.login(ids["王敏"])
    code, _ = c.post("/review/mentor-left", {"mentor_id": ids["郑强"]})
    check(code in (200,303) and scalar("SELECT is_active FROM users WHERE id=?",
                                 ids["郑强"]) == 0, "导师停用")
    check(scalar("SELECT COUNT(*) FROM transfer_requests WHERE plan_id=5 "
                 "AND reason LIKE '%离职%'") == 1, "自动生成改派申请")
    code, body = c.post("/match", {"request_id": r7, "mentor_id": ids["郑强"]})
    check("MENTOR_INACTIVE" in body, "离职导师不能再被配对")

    print("── 9. 消息回执与长期未开始提醒")
    check(scalar("SELECT COUNT(*) FROM messages WHERE mtype='STALE_PENDING'") == 1,
          "PENDING 6 天的计划启动时收到一次提醒")
    c.login(ids["冯雪"])
    check("STALE_PENDING" in c.get("/messages"), "消息回执页可查看提醒")

    print("── 10. 六个交付页面均可打开")
    for who, path in [("王敏", "/review"), ("褚琳", "/transfer"),
                      ("冯雪", "/schedule"), ("苏婷", "/plan?id=1"),
                      ("苏婷", "/messages")]:
        c.login(ids[who])
        check(c.get(path) is not None, f"{who} 访问 {path}")

    print(f"\n通过 {PASS}, 失败 {FAIL}")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
