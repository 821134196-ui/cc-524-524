"""领域服务: 配对/回避/容量竞争/时段冲突/换导师/离职/结项/纪要权限。

所有关键写操作在 BEGIN IMMEDIATE 事务中完成 "读剩余名额 -> 插入计划",
SQLite 写锁串行化, 保证并发配对不超额 (busy_timeout 等锁, 名额不足抛
CapacityFull)。
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta
from typing import Any

from .db import get_conn

# 长期未开始: PENDING 超过该天数即提醒
PENDING_REMIND_DAYS = 5


class DomainError(Exception):
    """业务规则拒绝。code 供页面/测试区分。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def now() -> datetime:
    return datetime.now()


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------- 消息适配器

class MockMessageAdapter:
    """模拟消息渠道: 不真正发送, 落库 messages 作为回执。"""

    def send(self, receiver_id: int, mtype: str, body: str) -> int:
        conn = get_conn()
        try:
            cur = conn.execute(
                "INSERT INTO messages(receiver_id,mtype,body,status,created_at) "
                "VALUES (?,?,?,?,?)",
                (receiver_id, mtype, body, "SENT", iso(now())),
            )
            return cur.lastrowid
        finally:
            conn.close()


messages = MockMessageAdapter()


# ---------------------------------------------------------------- 查询工具

def get_user(conn: sqlite3.Connection, user_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()


def get_mentor_profile(conn: sqlite3.Connection, mentor_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM mentors WHERE id=?", (mentor_id,)).fetchone()


def parse_slots(raw: str) -> list[dict[str, Any]]:
    return json.loads(raw)


def _periods_overlap(a: str, b: str) -> bool:
    def mins(p: str) -> tuple[int, int]:
        s, e = p.split("-")
        def m(t: str) -> int:
            h, mi = t.split(":")
            return int(h) * 60 + int(mi)
        return m(s), m(e)
    s1, e1 = mins(a)
    s2, e2 = mins(b)
    return s1 < e2 and s2 < e1


def mentor_slot_conflicts(conn: sqlite3.Connection, mentor_id: int,
                          slots: list[dict]) -> list[dict]:
    """返回 slots 中与导师当前有效时段冲突的项。"""
    conflicts = []
    for s in slots:
        row = conn.execute(
            "SELECT period FROM schedule_slots WHERE mentor_id=? AND active=1 "
            "AND weekday=?", (mentor_id, s["weekday"]),
        ).fetchall()
        if any(_periods_overlap(s["period"], r["period"]) for r in row):
            conflicts.append(s)
    return conflicts


def monthly_used(conn: sqlite3.Connection, mentor_id: int,
                 moment: datetime | None = None) -> int:
    """近 30 天滚动窗口已占用名额: 窗口内创建且未废弃的计划数。

    用滚动窗口而非自然月: 导师每月可带人数按带教周期限流,
    且月初启动演示时历史在带计划仍正确占额。
    """
    moment = moment or now()
    cutoff = iso(moment - timedelta(days=30))
    row = conn.execute(
        "SELECT COUNT(*) c FROM plans WHERE mentor_id=? AND status!='ABANDONED' "
        "AND created_at >= ?", (mentor_id, cutoff),
    ).fetchone()
    return row["c"]


def mentor_directory(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """导师目录: 擅长领域 + 近 30 天剩余名额, 仅在职导师。"""
    cutoff = iso(now() - timedelta(days=30))
    rows = conn.execute(
        """
        SELECT u.id, u.name, u.department, m.expertise, m.monthly_cap,
               m.accepts_cross,
               (m.monthly_cap - COALESCE((
                  SELECT COUNT(*) FROM plans p
                  WHERE p.mentor_id=m.id AND p.status!='ABANDONED'
                    AND p.created_at >= ?),0)) AS remaining
        FROM users u JOIN mentors m ON m.id=u.id
        WHERE u.is_active=1
        ORDER BY u.department, u.name
        """, (cutoff,),
    ).fetchall()
    return rows


# ---------------------------------------------------------------- 申请

def create_request(employee_id: int, skill: str,
                   slots: list[dict], note: str = "") -> int:
    if not skill.strip():
        raise DomainError("BAD_INPUT", "请填写希望提升的岗位技能")
    if not slots:
        raise DomainError("BAD_INPUT", "至少选择一个可交流时段")
    conn = get_conn()
    try:
        u = get_user(conn, employee_id)
        if u is None or not u["is_active"]:
            raise DomainError("USER_INACTIVE", "员工不存在或已离职")
        cur = conn.execute(
            "INSERT INTO match_requests(employee_id,skill,slots,note,status,created_at)"
            " VALUES (?,?,?,?,'OPEN',?)",
            (employee_id, skill.strip(), json.dumps(slots, ensure_ascii=False),
             note, iso(now()))
        )
        return cur.lastrowid
    finally:
        conn.close()


# ---------------------------------------------------------------- 主管配对

def _assert_manager(conn: sqlite3.Connection, user_id: int) -> sqlite3.Row:
    u = get_user(conn, user_id)
    if u is None or u["role"] != "manager":
        raise DomainError("FORBIDDEN", "仅主管可执行配对")
    return u


def match(manager_id: int, request_id: int, mentor_id: int) -> int:
    """主管确认配对, 返回 plan_id。关键段在 IMMEDIATE 事务内。

    拒绝情形: 请求不存在/非 OPEN、导师离职、技能不匹配、跨部门回避、
    时间全冲突、名额已满 (并发下也安全)。
    """
    conn = get_conn()
    try:
        manager = _assert_manager(conn, manager_id)
        for attempt in range(5):
            try:
                conn.execute("BEGIN IMMEDIATE")
                break
            except sqlite3.OperationalError:
                if attempt == 4:
                    raise DomainError("BUSY", "系统繁忙, 请重试")
        try:
            req = conn.execute(
                "SELECT * FROM match_requests WHERE id=?", (request_id,)
            ).fetchone()
            if req is None:
                raise DomainError("NOT_FOUND", "申请不存在")
            if req["status"] != "OPEN":
                raise DomainError("REQ_TAKEN", "该申请已处理或流转中")

            mentor_user = get_user(conn, mentor_id)
            mentor = get_mentor_profile(conn, mentor_id)
            if mentor_user is None or not mentor_user["is_active"] or mentor is None:
                raise DomainError("MENTOR_INACTIVE", "导师不存在或已离职")

            employee = get_user(conn, req["employee_id"])
            skills = [s.strip() for s in mentor["expertise"].split(",") if s.strip()]
            if req["skill"] not in skills:
                raise DomainError(
                    "SKILL_MISMATCH",
                    f"导师擅长领域为 {mentor['expertise']}, 不含 {req['skill']}")

            cross = int(employee["department"] != mentor_user["department"])
            if cross and not mentor["accepts_cross"]:
                raise DomainError(
                    "CROSS_DEPT",
                    f"跨部门回避: {mentor_user['name']}({mentor_user['department']})"
                    f" 不接受跨部门辅导")

            slots = parse_slots(req["slots"])
            conflicts = mentor_slot_conflicts(conn, mentor_id, slots)
            if len(conflicts) == len(slots):
                raise DomainError(
                    "TIME_CONFLICT",
                    "员工可交流时段与导师现有安排全部冲突, 请先协调时段或换导师")

            used = monthly_used(conn, mentor_id)
            if used >= mentor["monthly_cap"]:
                raise DomainError(
                    "CAPACITY_FULL",
                    f"导师 {mentor_user['name']} 本月名额已满 "
                    f"({used}/{mentor['monthly_cap']})")

            cur = conn.execute(
                "INSERT INTO plans(request_id,employee_id,mentor_id,cross_dept,"
                "status,created_at) VALUES (?,?,?,?, 'PENDING',?)",
                (request_id, req["employee_id"], mentor_id, cross, iso(now()))
            )
            plan_id = cur.lastrowid
            conn.execute(
                "UPDATE match_requests SET status='MATCHED' WHERE id=?", (request_id,))
            conn.commit()
        except Exception:
            conn.rollback()
            raise

        messages.send(req["employee_id"], "MATCH",
                      f"主管 {manager['name']} 已为你配对导师 "
                      f"{mentor_user['name']}（{req['skill']}），请确认时段安排。")
        return plan_id
    finally:
        conn.close()


# ---------------------------------------------------------------- 员工确认时段

def accept_plan(employee_id: int, plan_id: int,
                chosen_slot_ids: list[int] | None = None) -> list[int]:
    """员工确认辅导安排: 计划转 IN_PROGRESS 并落定时段。

    chosen_slot_ids 为申请时段在列表中的下标; 默认采用全部不冲突时段。
    """
    conn = get_conn()
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            plan = conn.execute("SELECT * FROM plans WHERE id=?", (plan_id,)).fetchone()
            if plan is None:
                raise DomainError("NOT_FOUND", "计划不存在")
            if plan["employee_id"] != employee_id:
                raise DomainError("FORBIDDEN", "只有该员工可确认安排")
            if plan["status"] != "PENDING":
                raise DomainError("BAD_STATE", f"计划当前状态为 {plan['status']}")
            mentor = get_user(conn, plan["mentor_id"])
            if not mentor["is_active"]:
                raise DomainError("MENTOR_INACTIVE",
                                  "导师已离职，请等待主管改派，可申请换导师")

            req = conn.execute(
                "SELECT * FROM match_requests WHERE id=?", (plan["request_id"],)
            ).fetchone()
            all_slots = parse_slots(req["slots"])
            if chosen_slot_ids is None:
                picked = [s for s in all_slots
                          if not mentor_slot_conflicts(conn, plan["mentor_id"], [s])]
            else:
                picked = [all_slots[i] for i in chosen_slot_ids if 0 <= i < len(all_slots)]
            if not picked:
                raise DomainError("TIME_CONFLICT", "没有可落定的无冲突时段")
            conflicts = mentor_slot_conflicts(conn, plan["mentor_id"], picked)
            if conflicts:
                raise DomainError("TIME_CONFLICT",
                                  f"时段冲突: {conflicts[0]['period']}")

            slot_ids = []
            for s in picked:
                cur = conn.execute(
                    "INSERT INTO schedule_slots(plan_id,mentor_id,employee_id,"
                    "weekday,period,active) VALUES (?,?,?,?,?,1)",
                    (plan_id, plan["mentor_id"], employee_id,
                     s["weekday"], s["period"]))
                slot_ids.append(cur.lastrowid)

            ts = iso(now())
            conn.execute(
                "UPDATE plans SET status='IN_PROGRESS', accepted_at=? WHERE id=?",
                (ts, plan_id))
            conn.commit()
        except Exception:
            conn.rollback()
            raise

        messages.send(plan["mentor_id"], "PLAN_START",
                      f"{get_user(conn, employee_id)['name']} 已确认时段，辅导开始。")
        return slot_ids
    finally:
        conn.close()


# ---------------------------------------------------------------- 纪要与权限

def plan_parties(conn: sqlite3.Connection, plan: sqlite3.Row) -> dict:
    return {
        "employee": get_user(conn, plan["employee_id"]),
        "mentor": get_user(conn, plan["mentor_id"]),
    }


def can_view_private(conn: sqlite3.Connection, user: sqlite3.Row,
                     plan: sqlite3.Row) -> bool:
    """私密反馈可见者: 当事员工、当事导师、授权主管(员工或导师所属部门主管)。"""
    if user is None:
        return False
    if user["id"] in (plan["employee_id"], plan["mentor_id"]):
        return True
    if user["role"] == "manager":
        parties = plan_parties(conn, plan)
        if user["department"] in (parties["employee"]["department"],
                                  parties["mentor"]["department"]):
            return True
    return False


def log_access(user_id: int | None, action: str, plan_id: int | None,
               allowed: bool, detail: str = "") -> None:
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO access_log(user_id,action,plan_id,allowed,detail,created_at)"
            " VALUES (?,?,?,?,?,?)",
            (user_id, action, plan_id, int(allowed), detail, iso(now())))
    finally:
        conn.close()


def visible_journal(conn: sqlite3.Connection, user: sqlite3.Row,
                    plan: sqlite3.Row) -> list[sqlite3.Row]:
    """按访问者过滤纪要; 任何私密条目查看都会写 access_log。"""
    rows = conn.execute(
        "SELECT * FROM journal_entries WHERE plan_id=? ORDER BY target_date, id",
        (plan["id"],)).fetchall()
    priv_count = sum(1 for r in rows if r["kind"] == "feedback_private")
    if priv_count:
        allowed = can_view_private(conn, user, plan)
        log_access(user["id"] if user else None, "VIEW_PRIVATE_FEEDBACK",
                   plan["id"], allowed,
                   "查看私密反馈" if allowed else "越权查看私密反馈被拒绝")
        if not allowed:
            rows = [r for r in rows if r["kind"] != "feedback_private"]
    return rows


def add_journal(actor_id: int, plan_id: int, kind: str, title: str,
                content: str, target_date: str | None = None) -> int:
    """写纪要。

    - goal/session: 计划当事双方均可写;
    - feedback_private: 仅当事人本人, 作者身份由登录态强制决定 ——
      导师无法以员工身份/替员工提交反馈。
    """
    if kind not in ("goal", "session", "feedback_private"):
        raise DomainError("BAD_INPUT", "未知纪要类型")
    if not title.strip() or not content.strip():
        raise DomainError("BAD_INPUT", "标题与内容不能为空")
    conn = get_conn()
    try:
        actor = get_user(conn, actor_id)
        if actor is None:
            raise DomainError("FORBIDDEN", "用户不存在")
        plan = conn.execute("SELECT * FROM plans WHERE id=?", (plan_id,)).fetchone()
        if plan is None:
            raise DomainError("NOT_FOUND", "计划不存在")
        if plan["status"] not in ("PENDING", "IN_PROGRESS"):
            raise DomainError("BAD_STATE", "计划已结束，不能再写纪要")

        if actor["id"] == plan["employee_id"]:
            author_role = "employee"
        elif actor["id"] == plan["mentor_id"]:
            author_role = "mentor"
        else:
            log_access(actor_id, "WRITE_JOURNAL", plan_id, False,
                       f"非当事人试图写 {kind}")
            raise DomainError("FORBIDDEN", "只有辅导双方可写纪要")

        # 私密反馈是个人意见: 不允许代笔 (作者角色只能取自登录态, 这里再显式拦截)
        if kind == "feedback_private" and author_role not in ("employee", "mentor"):
            raise DomainError("FORBIDDEN", "反馈须本人提交")

        cur = conn.execute(
            "INSERT INTO journal_entries(plan_id,kind,author_id,author_role,"
            "title,content,target_date,created_at) VALUES (?,?,?,?,?,?,?,?)",
            (plan_id, kind, actor_id, author_role, title.strip(), content.strip(),
             target_date, iso(now())))
        conn.commit()

        other = plan["mentor_id"] if author_role == "employee" else plan["employee_id"]
        messages.send(other, "JOURNAL",
                      f"{actor['name']} 在辅导计划中新增了"
                      f"{'目标' if kind == 'goal' else '私密反馈' if kind == 'feedback_private' else '进展记录'}。")
        return cur.lastrowid
    finally:
        conn.close()


# ---------------------------------------------------------------- 换导师

def request_transfer(employee_id: int, plan_id: int, reason: str,
                     new_mentor_id: int | None = None) -> int:
    if not reason.strip():
        raise DomainError("BAD_INPUT", "请填写换导师原因")
    conn = get_conn()
    try:
        plan = conn.execute("SELECT * FROM plans WHERE id=?", (plan_id,)).fetchone()
        if plan is None:
            raise DomainError("NOT_FOUND", "计划不存在")
        if plan["employee_id"] != employee_id:
            raise DomainError("FORBIDDEN", "只有员工本人可申请换导师")
        if plan["status"] not in ("PENDING", "IN_PROGRESS"):
            raise DomainError("BAD_STATE", "计划已结束，无需换导师")
        pend = conn.execute(
            "SELECT id FROM transfer_requests WHERE plan_id=? AND status='PENDING'",
            (plan_id,)).fetchone()
        if pend:
            raise DomainError("PENDING_EXISTS", "已有待审批的换导师申请")
        if new_mentor_id is not None:
            m = get_mentor_profile(conn, new_mentor_id)
            if m is None or not get_user(conn, new_mentor_id)["is_active"]:
                raise DomainError("MENTOR_INACTIVE", "意向导师不存在或已离职")
            if new_mentor_id == plan["mentor_id"]:
                raise DomainError("BAD_INPUT", "新导师不能与当前导师相同")
        cur = conn.execute(
            "INSERT INTO transfer_requests(plan_id,employee_id,reason,new_mentor_id,"
            "status,created_at) VALUES (?,?,?,?, 'PENDING',?)",
            (plan_id, employee_id, reason.strip(), new_mentor_id, iso(now())))
        conn.commit()
        tr_id = cur.lastrowid

        for mgr in _dept_managers(conn, plan, include_mentor_dept=True):
            messages.send(mgr["id"], "TRANSFER_REQ",
                          f"员工 {get_user(conn, employee_id)['name']} 申请换导师，"
                          f"原因：{reason.strip()}，待审批。")
        return tr_id
    finally:
        conn.close()


def _dept_managers(conn: sqlite3.Connection, plan: sqlite3.Row,
                   include_mentor_dept: bool = False) -> list[sqlite3.Row]:
    emp = get_user(conn, plan["employee_id"])
    depts = {emp["department"]}
    if include_mentor_dept:
        depts.add(get_user(conn, plan["mentor_id"])["department"])
    return conn.execute(
        f"SELECT * FROM users WHERE role='manager' AND department IN "
        f"({','.join('?' * len(depts))})", tuple(depts)).fetchall()


def review_transfer(manager_id: int, transfer_id: int, approve: bool,
                    new_mentor_id: int | None = None) -> int | None:
    """主管审批换导师。通过则: 旧计划废弃并释放时段/名额, 生成新 PENDING 计划。"""
    conn = get_conn()
    try:
        manager = _assert_manager(conn, manager_id)
        conn.execute("BEGIN IMMEDIATE")
        new_plan_id = None
        try:
            tr = conn.execute(
                "SELECT * FROM transfer_requests WHERE id=?", (transfer_id,)
            ).fetchone()
            if tr is None:
                raise DomainError("NOT_FOUND", "换导师申请不存在")
            if tr["status"] != "PENDING":
                raise DomainError("BAD_STATE", "该申请已审批")

            old_plan = conn.execute(
                "SELECT * FROM plans WHERE id=?", (tr["plan_id"],)).fetchone()
            parties = plan_parties(conn, old_plan)
            if manager["department"] not in (
                    parties["employee"]["department"], parties["mentor"]["department"]):
                raise DomainError("FORBIDDEN", "本部门主管才可审批该换导师申请")

            if not approve:
                conn.execute(
                    "UPDATE transfer_requests SET status='REJECTED', decided_at=?,"
                    "decided_by=? WHERE id=?", (iso(now()), manager_id, transfer_id))
                conn.commit()
                messages.send(tr["employee_id"], "TRANSFER_REJECTED",
                              f"你的换导师申请未被主管 {manager['name']} 批准，原辅导继续。")
                return None

            target_id = new_mentor_id or tr["new_mentor_id"]
            if target_id is None:
                raise DomainError("BAD_INPUT", "请指定接替导师")
            new_mentor_user = get_user(conn, target_id)
            new_profile = get_mentor_profile(conn, target_id)
            if new_mentor_user is None or not new_mentor_user["is_active"] \
                    or new_profile is None:
                raise DomainError("MENTOR_INACTIVE", "接替导师不存在或已离职")
            if target_id == old_plan["mentor_id"]:
                raise DomainError("BAD_INPUT", "新导师不能与当前导师相同")

            emp = get_user(conn, old_plan["employee_id"])
            cross = int(emp["department"] != new_mentor_user["department"])
            if cross and not new_profile["accepts_cross"]:
                raise DomainError(
                    "CROSS_DEPT",
                    f"跨部门回避: {new_mentor_user['name']} 不接受跨部门辅导")

            req = conn.execute(
                "SELECT * FROM match_requests WHERE id=?",
                (old_plan["request_id"],)).fetchone()
            slots = parse_slots(req["slots"])
            conflicts = mentor_slot_conflicts(conn, target_id, slots)
            if len(conflicts) == len(slots):
                raise DomainError("TIME_CONFLICT",
                                  "员工可交流时段与接替导师安排全部冲突")

            if monthly_used(conn, target_id) >= new_profile["monthly_cap"]:
                raise DomainError("CAPACITY_FULL",
                                  f"接替导师 {new_mentor_user['name']} 本月名额已满")

            # 旧计划废弃, 释放其占用的时段
            conn.execute(
                "UPDATE schedule_slots SET active=0 WHERE plan_id=?", (old_plan["id"],))
            conn.execute(
                "UPDATE plans SET status='ABANDONED', completed_at=? WHERE id=?",
                (iso(now()), old_plan["id"]))

            cur = conn.execute(
                "INSERT INTO plans(request_id,employee_id,mentor_id,cross_dept,"
                "status,predecessor_plan_id,created_at) "
                "VALUES (?,?,?,?, 'PENDING', ?,?)",
                (old_plan["request_id"], old_plan["employee_id"], target_id, cross,
                 old_plan["id"], iso(now())))
            new_plan_id = cur.lastrowid
            conn.execute(
                "UPDATE transfer_requests SET status='APPROVED', new_mentor_id=?,"
                "decided_at=?, decided_by=? WHERE id=?",
                (target_id, iso(now()), manager_id, transfer_id))
            conn.commit()
        except Exception:
            conn.rollback()
            raise

        messages.send(tr["employee_id"], "TRANSFER_APPROVED",
                      f"换导师已批准，新导师 {new_mentor_user['name']}，"
                      "请确认新的时段安排。")
        messages.send(target_id, "NEW_ASSIGNMENT",
                      f"主管 {manager['name']} 将 {emp['name']} 改派给你，请准备辅导。")
        return new_plan_id
    finally:
        conn.close()


# ---------------------------------------------------------------- 导师离职

def mark_mentor_left(manager_id: int, mentor_id: int) -> list[int]:
    """导师离职: 停用账号, 对其进行中的计划逐个生成系统换导师申请并通知员工。

    返回生成的改派申请 id。名额自然不再计入 (目录只列在职导师, 配对拦截离职)。
    """
    conn = get_conn()
    try:
        manager = _assert_manager(conn, manager_id)
        mentor_user = get_user(conn, mentor_id)
        if get_mentor_profile(conn, mentor_id) is None or mentor_user is None:
            raise DomainError("NOT_FOUND", "导师不存在")
        conn.execute("BEGIN IMMEDIATE")
        transfer_ids = []
        try:
            conn.execute(
                "UPDATE users SET is_active=0, left_at=? WHERE id=?",
                (iso(now()), mentor_id))
            active_plans = conn.execute(
                "SELECT * FROM plans WHERE mentor_id=? AND status IN "
                "('PENDING','IN_PROGRESS')", (mentor_id,)).fetchall()
            for p in active_plans:
                pend = conn.execute(
                    "SELECT id FROM transfer_requests WHERE plan_id=? AND status='PENDING'",
                    (p["id"],)).fetchone()
                if pend:
                    continue
                cur = conn.execute(
                    "INSERT INTO transfer_requests(plan_id,employee_id,reason,"
                    "new_mentor_id,status,created_at) VALUES (?,?,?,NULL,'PENDING',?)",
                    (p["id"], p["employee_id"],
                     f"导师 {mentor_user['name']} 已离职，系统发起改派", iso(now())))
                transfer_ids.append(cur.lastrowid)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        for p in active_plans:
            messages.send(p["employee_id"], "MENTOR_LEFT",
                          f"你的导师 {mentor_user['name']} 已离职，"
                          "主管将尽快为你改派新导师。")
        return transfer_ids
    finally:
        conn.close()


# ---------------------------------------------------------------- 结项审核

def request_completion(requester_id: int, plan_id: int, reason: str) -> int:
    """计划提前完成: 辅导任一方均可发起, 主管审核。"""
    if not reason.strip():
        raise DomainError("BAD_INPUT", "请填写提前结项原因")
    conn = get_conn()
    try:
        user = get_user(conn, requester_id)
        plan = conn.execute("SELECT * FROM plans WHERE id=?", (plan_id,)).fetchone()
        if plan is None:
            raise DomainError("NOT_FOUND", "计划不存在")
        if user["id"] not in (plan["employee_id"], plan["mentor_id"]):
            raise DomainError("FORBIDDEN", "只有辅导双方可申请结项")
        if plan["status"] not in ("PENDING", "IN_PROGRESS"):
            raise DomainError("BAD_STATE", "计划已结束")
        pend = conn.execute(
            "SELECT id FROM completion_requests WHERE plan_id=? AND status='PENDING'",
            (plan_id,)).fetchone()
        if pend:
            raise DomainError("PENDING_EXISTS", "已有待审批的结项申请")
        cur = conn.execute(
            "INSERT INTO completion_requests(plan_id,requester_id,reason,status,"
            "created_at) VALUES (?,?,?, 'PENDING',?)",
            (plan_id, requester_id, reason.strip(), iso(now())))
        conn.commit()
        cr_id = cur.lastrowid
        for mgr in _dept_managers(conn, plan, include_mentor_dept=True):
            messages.send(mgr["id"], "COMPLETION_REQ",
                          f"{user['name']} 申请提前结项（计划 #{plan_id}），待审核。")
        return cr_id
    finally:
        conn.close()


def review_completion(manager_id: int, completion_id: int, approve: bool) -> None:
    conn = get_conn()
    try:
        manager = _assert_manager(conn, manager_id)
        conn.execute("BEGIN IMMEDIATE")
        try:
            cr = conn.execute(
                "SELECT * FROM completion_requests WHERE id=?",
                (completion_id,)).fetchone()
            if cr is None:
                raise DomainError("NOT_FOUND", "结项申请不存在")
            if cr["status"] != "PENDING":
                raise DomainError("BAD_STATE", "该结项申请已审核")
            plan = conn.execute(
                "SELECT * FROM plans WHERE id=?", (cr["plan_id"],)).fetchone()
            parties = plan_parties(conn, plan)
            if manager["department"] not in (
                    parties["employee"]["department"], parties["mentor"]["department"]):
                raise DomainError("FORBIDDEN", "本部门主管才可审核该结项申请")

            if approve:
                conn.execute(
                    "UPDATE plans SET status='COMPLETED', completed_at=? WHERE id=?",
                    (iso(now()), plan["id"]))
                conn.execute(
                    "UPDATE schedule_slots SET active=0 WHERE plan_id=?",
                    (plan["id"],))
            conn.execute(
                "UPDATE completion_requests SET status=?, decided_at=?, decided_by=?"
                " WHERE id=?",
                ("APPROVED" if approve else "REJECTED",
                 iso(now()), manager_id, completion_id))
            conn.commit()
        except Exception:
            conn.rollback()
            raise

        verb = "批准" if approve else "驳回"
        messages.send(plan["employee_id"], "COMPLETION_REVIEW",
                      f"主管 {manager['name']} 已{verb}提前结项申请。")
        messages.send(plan["mentor_id"], "COMPLETION_REVIEW",
                      f"主管 {manager['name']} 已{verb}提前结项申请。")
    finally:
        conn.close()


# ---------------------------------------------------------------- 附件

def add_attachment(actor_id: int, plan_id: int, filename: str) -> int:
    """登记本地虚构附件 (文件内容由调用方写入 data/attachments)。"""
    conn = get_conn()
    try:
        actor = get_user(conn, actor_id)
        plan = conn.execute("SELECT * FROM plans WHERE id=?", (plan_id,)).fetchone()
        if plan is None:
            raise DomainError("NOT_FOUND", "计划不存在")
        if actor["id"] not in (plan["employee_id"], plan["mentor_id"]):
            raise DomainError("FORBIDDEN", "只有辅导双方可上传附件")
        cur = conn.execute(
            "INSERT INTO plan_attachments(plan_id,filename,uploaded_by,created_at)"
            " VALUES (?,?,?,?)",
            (plan_id, filename, actor_id, iso(now())))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def list_attachments(conn: sqlite3.Connection, user: sqlite3.Row,
                     plan: sqlite3.Row) -> list[sqlite3.Row]:
    """附件随计划私密: 当事双方 + 授权主管可见, 其余拒绝并审计。"""
    allowed = (user["id"] in (plan["employee_id"], plan["mentor_id"])
               or can_view_private(conn, user, plan))
    if not allowed:
        log_access(user["id"], "VIEW_ATTACHMENT", plan["id"], False, "越权查看附件被拒绝")
        raise DomainError("FORBIDDEN", "无权查看该计划附件")
    return conn.execute(
        "SELECT a.*, u.name uploader_name FROM plan_attachments a "
        "JOIN users u ON u.id=a.uploaded_by WHERE plan_id=? ORDER BY id",
        (plan["id"],)).fetchall()


# ---------------------------------------------------------------- 长期未开始

def pending_stale_plans(conn: sqlite3.Connection,
                        days: int = PENDING_REMIND_DAYS) -> list[sqlite3.Row]:
    cutoff = iso(now() - timedelta(days=days))
    return conn.execute(
        "SELECT p.* FROM plans p WHERE p.status='PENDING' AND p.created_at <= ?",
        (cutoff,)).fetchall()


def remind_stale_plans() -> int:
    """扫描长期未开始(PENDING)的计划, 给员工发提醒。同一计划只提醒一次。"""
    conn = get_conn()
    try:
        stale = pending_stale_plans(conn)
        sent = 0
        for p in stale:
            dup = conn.execute(
                "SELECT 1 FROM messages WHERE receiver_id=? AND mtype='STALE_PENDING'"
                " AND body LIKE ?",
                (p["employee_id"], f"%计划 #{p['id']}%")).fetchone()
            if dup:
                continue
            mentor = get_user(conn, p["mentor_id"])
            messages.send(
                p["employee_id"], "STALE_PENDING",
                f"你的辅导计划 #{p['id']}（导师 {mentor['name']}）已超过 "
                f"{PENDING_REMIND_DAYS} 天未确认开始，请尽快安排时段。")
            sent += 1
        return sent
    finally:
        conn.close()
