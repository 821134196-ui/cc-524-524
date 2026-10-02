"""领域测试: 容量竞争 / 跨部门回避 / 私密字段权限 / 结项 / 换导师 / 时间冲突。

每个用例使用独立临时 SQLite (import 前通过 MENTOR_DB_PATH 指定)。
"""
import json
import os
import tempfile
import threading
import unittest
from datetime import timedelta

_tmp = tempfile.mkdtemp(prefix="mentor_test_")
os.environ["MENTOR_DB_PATH"] = os.path.join(_tmp, "test.db")
os.environ["MENTOR_ATTACH_DIR"] = os.path.join(_tmp, "attach")

from app import services as svc  # noqa: E402
from app.db import get_conn, init_db  # noqa: E402
from app.services import DomainError, iso, now  # noqa: E402


class TestBase(unittest.TestCase):
    def setUp(self):
        path = os.environ["MENTOR_DB_PATH"]
        if os.path.exists(path):
            for suf in ("", "-wal", "-shm"):
                p = path + suf
                if os.path.exists(p):
                    os.remove(p)
        import app.db as dbmod
        dbmod._initialized = False
        init_db()
        self.conn = get_conn()
        self._build()

    def tearDown(self):
        self.conn.close()

    # -- 构造数据 --
    def u(self, name, dept, role):
        r = self.conn.execute(
            "INSERT INTO users(name,department,role,is_active) VALUES (?,?,?,1)",
            (name, dept, role))
        return r.lastrowid

    def mentor(self, uid, skills, cap, cross=0):
        self.conn.execute(
            "INSERT INTO mentors(id,expertise,monthly_cap,dept,accepts_cross)"
            " VALUES (?,?,?,?,?)",
            (uid, skills, cap,
             self.conn.execute("SELECT department FROM users WHERE id=?",
                               (uid,)).fetchone()["department"], cross))

    def request(self, emp, skill="Python 后端",
                slots=[{"weekday": 1, "period": "19:00-20:00"}]):
        r = self.conn.execute(
            "INSERT INTO match_requests(employee_id,skill,slots,note,status,created_at)"
            " VALUES (?,?,?,?,'OPEN',?)",
            (emp, skill, json.dumps(slots), "", iso(now())))
        return r.lastrowid

    def _build(self):
        self.mgr_eng = self.u("王工管", "工程部", "manager")
        self.mgr_mkt = self.u("陈市管", "市场部", "manager")
        self.mgr_hr = self.u("周人管", "人事部", "manager")

        self.m_zhang = self.u("张伟", "工程部", "mentor")
        self.mentor(self.m_zhang, "Python 后端,系统设计", 1, cross=0)
        self.m_li = self.u("李娜", "工程部", "mentor")
        self.mentor(self.m_li, "前端工程,Python 后端", 2, cross=1)  # 接受跨部门
        self.m_sun = self.u("孙悦", "市场部", "mentor")
        self.mentor(self.m_sun, "数据分析,品牌策划", 1, cross=0)

        self.e_su = self.u("苏婷", "工程部", "employee")
        self.e_lin = self.u("林一帆", "工程部", "employee")
        self.e_feng = self.u("冯雪", "市场部", "employee")
        self.e_other = self.u("钱多多", "市场部", "employee")
        self.conn.commit()

    def err_code(self, fn):
        with self.assertRaises(DomainError) as cm:
            fn()
        return cm.exception.code


class TestCapacityRace(TestBase):
    """两个主管并发配对同一导师(容量 1): 恰好一个成功, 绝不超额。"""

    def test_concurrent_match_no_overbook(self):
        r1 = self.request(self.e_su)
        r2 = self.request(self.e_lin)
        results = []
        barrier = threading.Barrier(2)

        def do_match(rid):
            barrier.wait()
            try:
                pid = svc.match(self.mgr_eng, rid, self.m_zhang)
                results.append(("ok", pid))
            except DomainError as e:
                results.append(("err", e.code))

        t1 = threading.Thread(target=do_match, args=(r1,))
        t2 = threading.Thread(target=do_match, args=(r2,))
        t1.start(); t2.start(); t1.join(); t2.join()

        oks = [r for r in results if r[0] == "ok"]
        errs = [r for r in results if r[0] == "err"]
        self.assertEqual(len(oks), 1, f"应恰好一个配对成功: {results}")
        self.assertEqual(len(errs), 1)
        self.assertEqual(errs[0][1], "CAPACITY_FULL")
        used = svc.monthly_used(self.conn, self.m_zhang)
        self.assertEqual(used, 1, "导师本月占用不得超过容量")
        # 失败的申请仍 OPEN
        st = self.conn.execute(
            "SELECT status FROM match_requests WHERE id IN (?,?) ORDER BY id",
            (r1, r2)).fetchall()
        self.assertEqual(sorted(s["status"] for s in st), ["MATCHED", "OPEN"])

    def test_sequential_full(self):
        r1 = self.request(self.e_su)
        svc.match(self.mgr_eng, r1, self.m_zhang)
        r2 = self.request(self.e_lin)
        self.assertEqual(self.err_code(
            lambda: svc.match(self.mgr_eng, r2, self.m_zhang)),
            "CAPACITY_FULL")


class TestCrossDept(TestBase):
    def test_cross_dept_blocked(self):
        # 市场部员工 -> 不接受跨部门的工程部张伟
        r = self.request(self.e_feng)
        self.assertEqual(self.err_code(
            lambda: svc.match(self.mgr_eng, r, self.m_zhang)), "CROSS_DEPT")

    def test_cross_dept_accepted_when_allowed(self):
        r = self.request(self.e_feng)
        pid = svc.match(self.mgr_eng, r, self.m_li)  # 李娜接受跨部门
        plan = self.conn.execute("SELECT cross_dept FROM plans WHERE id=?",
                                 (pid,)).fetchone()
        self.assertEqual(plan["cross_dept"], 1)

    def test_transfer_cross_dept_blocked(self):
        r = self.request(self.e_feng)
        pid = svc.match(self.mgr_eng, r, self.m_li)
        tr = svc.request_transfer(self.e_feng, pid, "想换导师")
        # 改派给不接受跨部门的张伟 -> 拒绝
        self.assertEqual(self.err_code(
            lambda: svc.review_transfer(self.mgr_eng, tr, True, self.m_zhang)),
            "CROSS_DEPT")

    def test_other_dept_manager_cannot_review(self):
        r = self.request(self.e_feng)
        pid = svc.match(self.mgr_eng, r, self.m_li)
        tr = svc.request_transfer(self.e_feng, pid, "时间不合")
        # 人事部主管无权审批市场部/工程部的辅导
        self.assertEqual(self.err_code(
            lambda: svc.review_transfer(self.mgr_hr, tr, True, self.m_li)),
            "FORBIDDEN")


class TestPrivatePermissions(TestBase):
    def _plan_with_private(self):
        r = self.request(self.e_su)
        pid = svc.match(self.mgr_eng, r, self.m_zhang)
        svc.add_journal(self.m_zhang, pid, "goal", "公开目标", "内容",
                        "2026-10-20")
        svc.add_journal(self.m_zhang, pid, "feedback_private",
                        "导师私密反馈", "仅当事人/授权主管可见")
        svc.add_journal(self.e_su, pid, "feedback_private",
                        "员工私密反馈", "导师也不应被当作作者代笔")
        return pid

    def test_parties_and_manager_see_private(self):
        pid = self._plan_with_private()
        mentor = self.conn.execute("SELECT * FROM users WHERE id=?",
                                   (self.m_zhang,)).fetchone()
        emp = self.conn.execute("SELECT * FROM users WHERE id=?",
                                (self.e_su,)).fetchone()
        mgr = self.conn.execute("SELECT * FROM users WHERE id=?",
                                (self.mgr_eng,)).fetchone()
        plan = self.conn.execute("SELECT * FROM plans WHERE id=?", (pid,)).fetchone()
        for viewer in (mentor, emp, mgr):
            rows = svc.visible_journal(self.conn, viewer, plan)
            self.assertTrue(any(x["kind"] == "feedback_private" for x in rows),
                            f"{viewer['name']} 应可见私密反馈")

    def test_outsider_cannot_see_private_and_audited(self):
        pid = self._plan_with_private()
        outsider = self.conn.execute("SELECT * FROM users WHERE id=?",
                                     (self.e_other,)).fetchone()
        other_mgr = self.conn.execute("SELECT * FROM users WHERE id=?",
                                      (self.mgr_hr,)).fetchone()
        plan = self.conn.execute("SELECT * FROM plans WHERE id=?", (pid,)).fetchone()
        for viewer in (outsider, other_mgr):
            rows = svc.visible_journal(self.conn, viewer, plan)
            self.assertFalse(any(x["kind"] == "feedback_private" for x in rows),
                             f"{viewer['name']} 不应看到私密反馈")
        denied = self.conn.execute(
            "SELECT COUNT(*) c FROM access_log WHERE allowed=0 "
            "AND action='VIEW_PRIVATE_FEEDBACK'").fetchone()["c"]
        self.assertGreaterEqual(denied, 2)

    def test_mentor_cannot_submit_as_employee(self):
        # 无代笔通道: 导师登录写入的反馈作者角色恒为 mentor
        pid = self._plan_with_private()
        new_id = svc.add_journal(self.m_zhang, pid, "feedback_private",
                                 "又一条反馈", "x")
        row = self.conn.execute(
            "SELECT author_id,author_role FROM journal_entries WHERE id=?",
            (new_id,)).fetchone()
        self.assertEqual(row["author_id"], self.m_zhang)
        self.assertEqual(row["author_role"], "mentor")
        # 非当事人写任何纪要均被拒绝
        self.assertEqual(self.err_code(
            lambda: svc.add_journal(self.e_other, pid, "goal", "x", "y")),
            "FORBIDDEN")

    def test_outsider_attachment_forbidden(self):
        pid = self._plan_with_private()
        att = svc.add_attachment(self.e_su, pid, "note.txt")
        outsider = self.conn.execute("SELECT * FROM users WHERE id=?",
                                     (self.e_other,)).fetchone()
        plan = self.conn.execute("SELECT * FROM plans WHERE id=?", (pid,)).fetchone()
        self.assertEqual(
            self.err_code(lambda: svc.list_attachments(self.conn, outsider, plan)),
            "FORBIDDEN")


class TestCompletion(TestBase):
    def _start_plan(self, emp=None):
        emp = emp or self.e_su
        r = self.request(emp)
        pid = svc.match(self.mgr_eng, r, self.m_li)
        svc.accept_plan(emp, pid)
        return pid

    def test_early_completion_approved_releases_slots(self):
        pid = self._start_plan()
        cr = svc.request_completion(self.e_su, pid, "目标提前达成")
        svc.review_completion(self.mgr_eng, cr, True)
        plan = self.conn.execute("SELECT status,completed_at FROM plans WHERE id=?",
                                 (pid,)).fetchone()
        self.assertEqual(plan["status"], "COMPLETED")
        self.assertIsNotNone(plan["completed_at"])
        active = self.conn.execute(
            "SELECT COUNT(*) c FROM schedule_slots WHERE plan_id=? AND active=1",
            (pid,)).fetchone()["c"]
        self.assertEqual(active, 0, "结项后时段应释放")
        # 结项后不能再写纪要
        self.assertEqual(self.err_code(
            lambda: svc.add_journal(self.e_su, pid, "goal", "x", "y")),
            "BAD_STATE")

    def test_completion_rejected_keeps_running(self):
        pid = self._start_plan()
        cr = svc.request_completion(self.e_su, pid, "想早点结束")
        svc.review_completion(self.mgr_eng, cr, False)
        st = self.conn.execute("SELECT status FROM plans WHERE id=?",
                               (pid,)).fetchone()["status"]
        self.assertEqual(st, "IN_PROGRESS")

    def test_mentor_can_request_completion(self):
        pid = self._start_plan()
        cr = svc.request_completion(self.m_li, pid, "导师评估已达标")
        row = self.conn.execute(
            "SELECT requester_id FROM completion_requests WHERE id=?",
            (cr,)).fetchone()
        self.assertEqual(row["requester_id"], self.m_li)

    def test_outsider_cannot_request_completion(self):
        pid = self._start_plan()
        self.assertEqual(self.err_code(
            lambda: svc.request_completion(self.e_other, pid, "x")), "FORBIDDEN")


class TestTransferAndTimeConflict(TestBase):
    def _start_plan(self):
        r = self.request(self.e_su)
        pid = svc.match(self.mgr_eng, r, self.m_zhang)
        svc.accept_plan(self.e_su, pid)
        return pid

    def test_transfer_creates_new_plan_and_releases_old(self):
        pid = self._start_plan()
        tr = svc.request_transfer(self.e_su, pid, "时间冲突", self.m_li)
        new_pid = svc.review_transfer(self.mgr_eng, tr, True, self.m_li)
        old = self.conn.execute("SELECT status FROM plans WHERE id=?",
                                (pid,)).fetchone()["status"]
        new = self.conn.execute(
            "SELECT status,predecessor_plan_id FROM plans WHERE id=?",
            (new_pid,)).fetchone()
        self.assertEqual(old, "ABANDONED")
        self.assertEqual(new["status"], "PENDING")
        self.assertEqual(new["predecessor_plan_id"], pid)
        active = self.conn.execute(
            "SELECT COUNT(*) c FROM schedule_slots WHERE plan_id=? AND active=1",
            (pid,)).fetchone()["c"]
        self.assertEqual(active, 0)

    def test_transfer_capacity_full(self):
        # 李娜接受跨部门但 cap=2; 先用两名市场部员工占满
        f_slots = [{"weekday": 2, "period": "09:00-10:00"}]
        q_slots = [{"weekday": 5, "period": "09:00-10:00"}]
        r1 = self.request(self.e_feng, slots=f_slots)
        svc.match(self.mgr_eng, r1, self.m_li)
        r2 = self.request(self.e_other, slots=q_slots)
        svc.match(self.mgr_eng, r2, self.m_li)
        self.assertEqual(svc.monthly_used(self.conn, self.m_li), 2)

        pid = self._start_plan()
        tr = svc.request_transfer(self.e_su, pid, "想换导师", None)
        # 苏婷时段为周一 19:00, 与李娜现有时段不冲突, 但名额已满
        self.assertEqual(self.err_code(
            lambda: svc.review_transfer(self.mgr_eng, tr, True, self.m_li)),
            "CAPACITY_FULL")

    def test_match_all_slots_conflict(self):
        # 张老师周一 19:00-20:00 已被占用; 仅给同一时段的新申请应拒绝
        r0 = self.request(self.e_su)
        p0 = svc.match(self.mgr_eng, r0, self.m_zhang)
        svc.accept_plan(self.e_su, p0)
        r1 = self.request(self.e_lin)  # 同时段
        self.assertEqual(self.err_code(
            lambda: svc.match(self.mgr_eng, r1, self.m_zhang)),
            "TIME_CONFLICT")

    def test_partial_overlap_still_matches(self):
        # 员工给两个时段, 仅一个与导师安排冲突 -> 配对成功;
        # 员工确认时默认只落定无冲突时段
        r0 = self.request(self.e_su)
        p0 = svc.match(self.mgr_eng, r0, self.m_li)
        svc.accept_plan(self.e_su, p0)
        r1 = self.request(self.e_lin, slots=[
            {"weekday": 1, "period": "19:00-20:00"},
            {"weekday": 3, "period": "12:30-13:00"}])
        p1 = svc.match(self.mgr_eng, r1, self.m_li)
        svc.accept_plan(self.e_lin, p1)
        slots = self.conn.execute(
            "SELECT weekday,period FROM schedule_slots WHERE plan_id=? AND active=1",
            (p1,)).fetchall()
        self.assertEqual([(s["weekday"], s["period"]) for s in slots],
                         [(3, "12:30-13:00")])

    def test_accept_with_only_conflict_slots_fails(self):
        # 计划生成后导师时段被占满, 员工再确认应被拦截
        r = self.request(self.e_su)
        pid = svc.match(self.mgr_eng, r, self.m_zhang)
        # 另一占满周一 19:00-20:00 的活跃时段直接挂在张老师名下
        self.conn.execute(
            "INSERT INTO schedule_slots(plan_id,mentor_id,employee_id,weekday,"
            "period,active) VALUES (?,?,?,?,?,1)",
            (pid, self.m_zhang, self.e_lin, 1, "19:00-20:00"))
        self.conn.commit()
        self.assertEqual(self.err_code(
            lambda: svc.accept_plan(self.e_su, pid)), "TIME_CONFLICT")


class TestMentorLeftAndReminder(TestBase):
    def test_mentor_left_triggers_reassignment(self):
        r = self.request(self.e_su)
        pid = svc.match(self.mgr_eng, r, self.m_zhang)
        svc.accept_plan(self.e_su, pid)
        ids = svc.mark_mentor_left(self.mgr_eng, self.m_zhang)
        self.assertEqual(len(ids), 1)
        tr = self.conn.execute("SELECT * FROM transfer_requests WHERE id=?",
                               (ids[0],)).fetchone()
        self.assertEqual(tr["status"], "PENDING")
        self.assertIn("离职", tr["reason"])
        # 离职导师不再出现在目录, 也无法被配对
        dirs = svc.mentor_directory(self.conn)
        self.assertFalse(any(d["id"] == self.m_zhang for d in dirs))
        r2 = self.request(self.e_lin)
        self.assertEqual(self.err_code(
            lambda: svc.match(self.mgr_eng, r2, self.m_zhang)),
            "MENTOR_INACTIVE")

    def test_stale_pending_reminder_once(self):
        r = self.request(self.e_su)
        pid = svc.match(self.mgr_eng, r, self.m_zhang)
        # 置为 6 天前创建
        old = iso(now() - timedelta(days=6))
        self.conn.execute("UPDATE plans SET created_at=? WHERE id=?", (old, pid))
        self.conn.commit()
        n1 = svc.remind_stale_plans()
        n2 = svc.remind_stale_plans()
        self.assertEqual(n1, 1)
        self.assertEqual(n2, 0, "同一计划不应重复提醒")
        msgs = self.conn.execute(
            "SELECT COUNT(*) c FROM messages WHERE mtype='STALE_PENDING'").fetchone()
        self.assertEqual(msgs["c"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
