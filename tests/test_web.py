"""HTTP 端到端冒烟测试: 私密字段在页面层的可见性 + 登录态身份不可伪造。"""
import http.client
import json
import os
import tempfile
import threading
import unittest
import urllib.parse
from http.cookiejar import CookieJar
from urllib.request import HTTPCookieProcessor, Request, build_opener

_tmp = tempfile.mkdtemp(prefix="mentor_web_test_")
os.environ["MENTOR_DB_PATH"] = os.path.join(_tmp, "web.db")
os.environ["MENTOR_ATTACH_DIR"] = os.path.join(_tmp, "attach")

from app import services as svc  # noqa: E402
from app.db import get_conn, init_db  # noqa: E402
from app.services import iso, now  # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402
from app.web import Handler  # noqa: E402


class WebTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        cls._seed()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    @classmethod
    def _seed(cls):
        conn = get_conn()
        r = conn.execute(
            "INSERT INTO users(name,department,role,is_active) VALUES (?,?,?,1)",
            ("王主管", "工程部", "manager")).lastrowid
        m = conn.execute(
            "INSERT INTO users(name,department,role,is_active) VALUES (?,?,?,1)",
            ("张导师", "工程部", "mentor")).lastrowid
        conn.execute(
            "INSERT INTO mentors(id,expertise,monthly_cap,dept,accepts_cross)"
            " VALUES (?,?,?,?,?)", (m, "Python 后端", 2, "工程部", 0))
        e = conn.execute(
            "INSERT INTO users(name,department,role,is_active) VALUES (?,?,?,1)",
            ("李员工", "工程部", "employee")).lastrowid
        o = conn.execute(
            "INSERT INTO users(name,department,role,is_active) VALUES (?,?,?,1)",
            ("路人甲", "市场部", "employee")).lastrowid
        rr = conn.execute(
            "INSERT INTO match_requests(employee_id,skill,slots,status,created_at)"
            " VALUES (?,?,?, 'OPEN',?)",
            (e, "Python 后端",
             json.dumps([{"weekday": 1, "period": "19:00-20:00"}]), iso(now())))
        conn.commit()
        pid = svc.match(r, rr.lastrowid, m)
        svc.add_journal(m, pid, "goal", "公开目标X", "公开内容", "2026-10-20")
        svc.add_journal(m, pid, "feedback_private", "导师私密Y", "秘密内容Z")
        cls.mgr, cls.men, cls.emp, cls.outsider, cls.pid = r, m, e, o, pid

    def client(self, uid=None):
        jar = CookieJar()
        op = build_opener(HTTPCookieProcessor(jar))
        if uid:
            op.open(f"http://127.0.0.1:{self.port}/login",
                    data=urllib.parse.urlencode({"uid": uid}).encode())
        return op

    def get(self, op, path):
        resp = op.open(f"http://127.0.0.1:{self.port}{path}")
        return resp.read().decode()

    def test_directory_shows_remaining(self):
        op = self.client(self.emp)
        page = self.get(op, "/")
        self.assertIn("张导师", page)
        self.assertIn("Python 后端", page)
        self.assertIn("剩余名额", page)

    def test_private_visibility_by_role(self):
        # 当事人员工可见
        page = self.get(self.client(self.emp), f"/plan?id={self.pid}")
        self.assertIn("导师私密Y", page)
        self.assertIn("目标时间线", page)
        # 授权主管可见
        page = self.get(self.client(self.mgr), f"/plan?id={self.pid}")
        self.assertIn("秘密内容Z", page)
        # 市场部路人不可见, 页面给出隔离提示
        page = self.get(self.client(self.outsider), f"/plan?id={self.pid}")
        self.assertNotIn("秘密内容Z", page)
        self.assertIn("对你不可见", page)
        conn = get_conn()
        denied = conn.execute(
            "SELECT COUNT(*) c FROM access_log WHERE allowed=0").fetchone()["c"]
        conn.close()
        self.assertGreaterEqual(denied, 1)

    def test_feedback_identity_bound_to_session(self):
        op = self.client(self.men)
        data = urllib.parse.urlencode({
            "plan_id": self.pid, "kind": "feedback_private",
            "title": "导师新反馈", "content": "内容",
            "target_date": ""}).encode()
        resp = op.open(f"http://127.0.0.1:{self.port}/plan/journal", data=data)
        self.assertEqual(resp.status, 200)
        conn = get_conn()
        row = conn.execute(
            "SELECT author_id,author_role FROM journal_entries WHERE title='导师新反馈'"
        ).fetchone()
        conn.close()
        self.assertEqual(row["author_id"], self.men)
        self.assertEqual(row["author_role"], "mentor")  # 无法冒充员工

    def test_manager_review_page(self):
        op = self.client(self.mgr)
        page = self.get(op, "/review")
        self.assertIn("待配对申请", page)
        self.assertIn("结项审核", page)


if __name__ == "__main__":
    unittest.main(verbosity=2)
