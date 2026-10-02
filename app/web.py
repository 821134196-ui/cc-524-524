"""零依赖 Web 层 (http.server + ThreadingHTTPServer)。

页面:
  /                 导师目录 (擅长领域 + 剩余名额)
  /apply            匹配申请 (技能 + 可交流时段)
  /schedule         我的辅导/时段安排
  /plan?id=         辅导纪要 (公开目标时间线 / 私密反馈分区)
  /transfer         换导师
  /review           主管工作台: 配对 + 换导师/结项审核
  /messages         消息回执
登录: /login 选择演示身份 (cookie uid)。
"""
from __future__ import annotations

import html
import json
import re
import urllib.parse
from http.cookies import SimpleCookie
from pathlib import Path

from . import services as svc
from .db import attachment_dir, get_conn, init_db
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

# 办公白 / 炭灰 / 明快绿
C = {
    "bg": "#f5f7f6", "card": "#ffffff", "ink": "#2b2f33", "sub": "#6b7177",
    "line": "#e3e7e5", "green": "#1f9d6b", "green_d": "#177a52",
    "green_bg": "#e8f6f0", "amber": "#b4690e", "red": "#b4332f",
}


def esc(v) -> str:
    return html.escape("" if v is None else str(v), quote=True)


# ---------------------------------------------------------------- 页面模板

def shell(title: str, user, body: str, flash: str = "") -> str:
    nav = ""
    if user:
        links = [("/", "导师目录"), ("/schedule", "我的辅导"),
                 ("/transfer", "换导师"), ("/messages", "消息回执")]
        if user["role"] == "manager":
            links.insert(3, ("/review", "主管工作台"))
        nav = "".join(
            f'<a href="{u}">{t}</a>' for u, t in links)
        who = (f'<span class="who">{esc(user["name"])}·{esc(user["department"])}'
               f'·{ {"employee":"员工","mentor":"导师","manager":"主管"}[user["role"]] }</span>'
               f'<form method="post" action="/logout" class=inline>'
               f'<button class="btn ghost sm">退出</button></form>')
    else:
        who = '<a href="/login" class="btn green sm">登录</a>'
    flash_html = f'<div class="flash">{esc(flash)}</div>' if flash else ""
    return f"""<!doctype html><html lang=zh><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>{esc(title)} · 导师配对</title>
<style>
:root{{--ink:{C['ink']};--sub:{C['sub']};--line:{C['line']};--g:{C['green']};
--gd:{C['green_d']};--gb:{C['green_bg']};}}
*{{box-sizing:border-box}}
body{{margin:0;font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
background:{C['bg']};color:var(--ink)}}
header{{background:{C['card']};border-bottom:1px solid var(--line);padding:0 24px;
display:flex;align-items:center;gap:20px;height:56px;position:sticky;top:0;z-index:5}}
header .brand{{font-weight:700;color:var(--gd)}}
header nav{{display:flex;gap:4px;flex:1}}
header nav a{{color:var(--sub);text-decoration:none;padding:6px 12px;border-radius:8px}}
header nav a:hover{{background:var(--gb);color:var(--gd)}}
.who{{color:var(--sub);font-size:13px}}
main{{max-width:1000px;margin:24px auto;padding:0 20px}}
h1{{font-size:20px;margin:0 0 16px}} h2{{font-size:16px;margin:24px 0 10px}}
.card{{background:{C['card']};border:1px solid var(--line);border-radius:12px;
padding:18px 20px;margin-bottom:16px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}}
.mentor{{border:1px solid var(--line);border-radius:12px;padding:16px;background:#fff}}
.mentor h3{{margin:0 0 2px;font-size:15px}}
.dept{{color:var(--sub);font-size:12px}}
.tags{{margin:8px 0}}
.tag{{display:inline-block;background:var(--gb);color:var(--gd);border-radius:20px;
padding:2px 10px;font-size:12px;margin:0 6px 6px 0}}
.cap{{display:inline-flex;align-items:center;gap:6px;font-size:13px;margin-top:4px}}
.dot{{width:8px;height:8px;border-radius:50%;background:var(--g)}}
.dot.zero{{background:#c2c7cb}}
table{{width:100%;border-collapse:collapse}}
th,td{{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);
vertical-align:top;font-size:13.5px}}
th{{color:var(--sub);font-weight:600;font-size:12.5px}}
.btn{{display:inline-block;border:1px solid var(--g);background:var(--g);color:#fff;
padding:7px 16px;border-radius:8px;text-decoration:none;cursor:pointer;font-size:13.5px}}
.btn:hover{{background:var(--gd)}}
.btn.ghost{{background:#fff;color:var(--sub);border-color:var(--line)}}
.btn.ghost:hover{{color:var(--gd);border-color:var(--g)}}
.btn.sm{{padding:4px 10px;font-size:12.5px}}
.btn.danger{{background:#fff;color:{C['red']};border-color:#e0b4b2}}
form.inline{{display:inline}}
label{{display:block;font-size:13px;color:var(--sub);margin:10px 0 4px}}
input[type=text],textarea,select{{width:100%;padding:8px 10px;border:1px solid var(--line);
border-radius:8px;font:inherit;background:#fff}}
textarea{{min-height:70px;resize:vertical}}
.flash{{background:var(--gb);border:1px solid #bfe3d3;color:var(--gd);
padding:10px 14px;border-radius:10px;margin-bottom:14px}}
.err{{background:#fbeeec;border:1px solid #e0b4b2;color:{C['red']};
padding:10px 14px;border-radius:10px;margin-bottom:14px}}
.badge{{display:inline-block;border-radius:6px;padding:1px 8px;font-size:12px}}
.b-pending{{background:#fdf3e2;color:var(--amber)}}
.b-progress{{background:var(--gb);color:var(--gd)}}
.b-done{{background:#eef1f0;color:var(--sub)}}
.b-abandon{{background:#f4f4f4;color:#999}}
.lock{{background:#f3f4f5;border:1px dashed #c9cfcc;border-radius:12px;padding:16px}}
.lock h3{{margin:0 0 4px;font-size:14px}}
.timeline{{border-left:2px solid var(--gb);margin-left:8px;padding-left:18px}}
.tl{{position:relative;margin-bottom:14px}}
.tl:before{{content:"";position:absolute;left:-25px;top:6px;width:10px;height:10px;
border-radius:50%;background:var(--g);border:2px solid #fff;box-shadow:0 0 0 2px var(--g)}}
.tl .date{{font-size:12px;color:var(--sub)}}
.muted{{color:var(--sub)}} .mono{{font-family:ui-monospace,Menlo,monospace}}
.right{{text-align:right}} .row{{display:flex;gap:10px;align-items:center;flex-wrap:wrap}}
.spread{{justify-content:space-between}}
.slotline{{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;background:#f7f9f8;
border:1px solid var(--line);border-radius:6px;padding:2px 8px;margin:2px 0;display:inline-block}}
.checks label{{display:inline-block;margin-right:14px;color:var(--ink)}}
.kind-private{{border-left:3px solid #c2c7cb}}
.kind-goal{{border-left:3px solid var(--g)}}
.kind-session{{border-left:3px solid #8fb9d6}}
.entry{{padding:8px 12px;margin-bottom:8px;background:#fafbfa;border-radius:0 8px 8px 0}}
.entry .meta{{font-size:12px;color:var(--sub)}}
footer{{color:var(--sub);font-size:12px;text-align:center;margin:30px}}
</style></head><body>
<header><span class=brand>🌿 导师配对</span><nav>{nav}</nav>{who}</header>
<main><h1>{esc(title)}</h1>{flash_html}{body}</main>
<footer>企业新员工导师系统 · SQLite 本地存储 · 消息与提醒为进程内模拟</footer>
</body></html>"""


def status_badge(s: str) -> str:
    labels = {"OPEN": "待配对", "MATCHED": "已配对", "CANCELLED": "已取消",
              "TRANSFERRING": "换导师中", "PENDING": "待开始", "IN_PROGRESS": "辅导中",
              "COMPLETED": "已结项", "ABANDONED": "已废弃",
              "PENDING_APP": "待审批", "APPROVED": "已批准", "REJECTED": "已驳回",
              "CANCELLED_APP": "已撤销"}
    cls = {"PENDING": "b-pending", "IN_PROGRESS": "b-progress",
           "COMPLETED": "b-done", "ABANDONED": "b-abandon", "OPEN": "b-pending",
           "MATCHED": "b-progress"}.get(s, "b-done")
    return f'<span class="badge {cls}">{labels.get(s, s)}</span>'


# ---------------------------------------------------------------- HTTP 处理器

class Handler(BaseHTTPRequestHandler):
    server_version = "MentorMatch/1.0"

    # -- 基础 --
    def log_message(self, fmt, *args):
        pass

    @property
    def conn(self):
        return get_conn()

    def _current_user(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        if "uid" not in cookie:
            return None
        try:
            uid = int(cookie["uid"].value)
        except ValueError:
            return None
        conn = self.conn
        try:
            return conn.execute(
                "SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        finally:
            conn.close()

    def _form(self) -> dict[str, str]:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        parsed = urllib.parse.parse_qs(raw)
        return {k: v[0] for k, v in parsed.items()}

    def _send(self, content: str, code: int = 200,
              extra_headers: list[tuple[str, str]] | None = None):
        data = content.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for k, v in extra_headers or []:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _redirect(self, path: str, msg: str = ""):
        if msg:
            sep = "&" if "?" in path else "?"
            path = f"{path}{sep}msg={urllib.parse.quote(msg)}"
        self._send("", 303, [("Location", path)])

    def _page(self, title, body, user, flash="", code=200):
        self._send(shell(title, user, body, flash), code)

    def _error(self, user, code: int, text: str):
        body = f'<div class=err><b>{code}</b> · {esc(text)}</div>'
        self._page("出错了", body, user, code=code)

    def _require_login(self):
        user = self._current_user()
        if not user:
            self._redirect("/login")
            return None
        return user

    # -- 路由 --
    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        msg = qs.get("msg", [""])[0]
        path = parsed.path
        try:
            if path == "/login":
                return self.page_login()
            if path == "/":
                return self.page_directory(msg)
            if path == "/apply":
                return self.page_apply(msg)
            if path == "/schedule":
                return self.page_schedule(msg)
            if path == "/plan":
                return self.page_plan(int(qs["id"][0]), msg)
            if path == "/transfer":
                return self.page_transfer(msg)
            if path == "/review":
                return self.page_review(msg)
            if path == "/messages":
                return self.page_messages(msg)
            if path == "/attachment":
                return self.page_download(int(qs["id"][0]))
            self._error(self._current_user(), 404, "页面不存在")
        except svc.DomainError as e:
            self._error(self._current_user(), 400, f"[{e.code}] {e.message}")
        except Exception as e:  # noqa
            self._error(self._current_user(), 500, f"{type(e).__name__}: {e}")

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        form = self._form()
        try:
            if path == "/login":
                return self._do_login(form)
            if path == "/logout":
                return self._do_logout()
            user = self._require_login()
            if not user:
                return
            if path == "/apply":
                return self.post_apply(user, form)
            if path == "/match":
                return self.post_match(user, form)
            if path == "/plan/accept":
                return self.post_accept(user, form)
            if path == "/plan/journal":
                return self.post_journal(user, form)
            if path == "/plan/complete":
                return self.post_request_completion(user, form)
            if path == "/plan/attach":
                return self.post_attach(user, form)
            if path == "/transfer":
                return self.post_transfer(user, form)
            if path == "/review/transfer":
                return self.post_review_transfer(user, form)
            if path == "/review/completion":
                return self.post_review_completion(user, form)
            if path == "/review/mentor-left":
                return self.post_mentor_left(user, form)
            self._error(user, 404, "接口不存在")
        except svc.DomainError as e:
            code = 403 if e.code == "FORBIDDEN" else 400
            self._error(user, code, f"[{e.code}] {e.message}")
        except Exception as e:  # noqa
            self._error(user, 500, f"{type(e).__name__}: {e}")

    # -- 登录 --
    def page_login(self):
        conn = self.conn
        users = conn.execute(
            "SELECT * FROM users WHERE is_active=1 ORDER BY role,id").fetchall()
        conn.close()
        groups = {}
        names = {"employee": "员工", "mentor": "导师", "manager": "主管"}
        for u in users:
            groups.setdefault(u["role"], []).append(u)
        blocks = ""
        for role in ("manager", "mentor", "employee"):
            opts = "".join(
                f'<button class="btn ghost" name=uid value="{u["id"]}" '
                f'style="margin:4px 8px 4px 0">'
                f'{esc(u["name"])}（{esc(u["department"])}）</button>'
                for u in groups.get(role, []))
            blocks += f'<h2>{names[role]}</h2><div>{opts}</div>'
        body = (f'<div class=card><form method=post action=/login>{blocks}</form>'
                '<p class=muted>演示登录：直接选择身份，私密反馈的可见范围随身份变化。</p></div>')
        self._page("登录", body, self._current_user())

    def _do_login(self, form):
        uid = int(form["uid"])
        self._send("", 303, [("Location", "/"),
                             ("Set-Cookie", f"uid={uid}; Path=/; HttpOnly")])

    def _do_logout(self):
        self._send("", 303, [("Location", "/login"),
                             ("Set-Cookie", "uid=; Path=/; Max-Age=0")])

    # -- 导师目录 --
    def page_directory(self, msg):
        user = self._require_login()
        if not user:
            return
        conn = self.conn
        rows = svc.mentor_directory(conn)
        cards = ""
        for m in rows:
            tags = "".join(f'<span class=tag>{esc(t.strip())}</span>'
                           for t in m["expertise"].split(",") if t.strip())
            zero = m["remaining"] <= 0
            cross = "" if m["accepts_cross"] else '<span class=muted>· 仅本部门</span>'
            apply_link = ""
            if user["role"] == "employee":
                apply_link = (f'<a class="btn sm" href="/apply?mentor={m["id"]}">'
                              f'申请匹配</a>')
            cards += (
                f'<div class=mentor><h3>{esc(m["name"])}</h3>'
                f'<div class=dept>{esc(m["department"])} {cross}</div>'
                f'<div class=tags>{tags}</div>'
                f'<div class=row spread><span class=cap>'
                f'<span class="dot{" zero" if zero else ""}"></span>'
                f'剩余名额 <b>{m["remaining"]}</b>/{m["monthly_cap"]}（本月）</span>'
                f'{apply_link}</div></div>')
        body = (f'<p class=muted>每位导师姓名旁标注擅长领域与本月剩余名额；'
                f'名额为 0 时无法配对。</p><div class=grid>{cards}</div>')
        self._page("导师目录", body, user, msg)

    # -- 匹配申请 --
    def page_apply(self, msg):
        user = self._require_login()
        if not user:
            return
        conn = self.conn
        mentors = svc.mentor_directory(conn)
        skills = sorted({t.strip() for m in mentors
                         for t in m["expertise"].split(",") if t.strip()})
        skill_opts = "".join(f'<option value="{esc(s)}">{esc(s)}</option>'
                             for s in skills)
        wd_checks = "".join(
            f'<label><input type=checkbox name=wd value="{i}"> {WEEKDAYS[i]}</label>'
            for i in range(7))
        body = f"""
        <div class=card>
        <form method=post action=/apply>
          <label>希望提升的岗位技能</label>
          <input type=text name=skill list=skills placeholder="如：Python 后端">
          <datalist id=skills>{skill_opts}</datalist>
          <label>可交流时段（勾选工作日并填写时间段）</label>
          <div class=checks>{wd_checks}</div>
          <label>时间段（多个用英文逗号分隔，如 19:00-20:00,12:30-13:00）</label>
          <input type=text name=periods value="19:00-20:00">
          <label>备注</label><textarea name=note placeholder="想提升的方向或期望"></textarea>
          <p style="margin-top:14px"><button class="btn">提交申请</button>
          <a class="btn ghost" href=/>返回目录</a></p>
        </form></div>
        <p class=muted>申请提交后由主管确认配对；跨部门导师若不接受跨部门会被回避，
        时段与导师现有安排全部冲突时配对将被拒绝。</p>"""
        self._page("匹配申请", body, user, msg)

    def post_apply(self, user, form):
        slots = self._slots_from_form(form)
        rid = svc.create_request(user["id"], form.get("skill", ""), slots,
                                 form.get("note", ""))
        self._redirect("/schedule", f"申请 #{rid} 已提交，等待主管配对")

    def _slots_from_form(self, form):
        # wd 多值: _form 折叠了, 这里从缓存取
        wd_values = getattr(self, "_raw_form", {}).get("wd", [])
        periods = []
        for p in re.split(r"[,，]", form.get("periods", "")):
            p = p.strip()
            if re.fullmatch(r"\d{1,2}:\d{2}-\d{1,2}:\d{2}", p):
                periods.append(p)
        slots = [{"weekday": int(w), "period": p}
                 for w in wd_values for p in periods]
        return slots

    # -- 我的辅导 / 时段安排 --
    def page_schedule(self, msg):
        user = self._require_login()
        if not user:
            return
        conn = self.conn
        if user["role"] == "manager":
            plans = conn.execute(
                "SELECT p.*, e.name ename, m.name mname, e.department edept, m.department mdept "
                "FROM plans p JOIN users e ON e.id=p.employee_id "
                "JOIN users m ON m.id=p.mentor_id "
                "WHERE (e.department=? OR m.department=?) ORDER BY p.id DESC",
                (user["department"], user["department"])).fetchall()
        elif user["role"] == "mentor":
            plans = conn.execute(
                "SELECT p.*, e.name ename, m.name mname, e.department edept, m.department mdept "
                "FROM plans p JOIN users e ON e.id=p.employee_id "
                "JOIN users m ON m.id=p.mentor_id WHERE p.mentor_id=? ORDER BY p.id DESC",
                (user["id"],)).fetchall()
        else:
            plans = conn.execute(
                "SELECT p.*, e.name ename, m.name mname, e.department edept, m.department mdept "
                "FROM plans p JOIN users e ON e.id=p.employee_id "
                "JOIN users m ON m.id=p.mentor_id WHERE p.employee_id=? ORDER BY p.id DESC",
                (user["id"],)).fetchall()

        reqs = []
        if user["role"] == "employee":
            reqs = conn.execute(
                "SELECT * FROM match_requests WHERE employee_id=? ORDER BY id DESC",
                (user["id"],)).fetchall()

        rows_html = ""
        for p in plans:
            slots = conn.execute(
                "SELECT * FROM schedule_slots WHERE plan_id=? AND active=1",
                (p["id"],)).fetchall()
            slot_txt = "".join(
                f'<div class=slotline>{WEEKDAYS[s["weekday"]]} {esc(s["period"])}</div>'
                for s in slots) or '<span class=muted>未落定</span>'
            cross = '<span class=tag>跨部门</span>' if p["cross_dept"] else ""
            actions = f'<a class="btn sm" href="/plan?id={p["id"]}">辅导纪要</a>'
            if user["role"] == "employee" and p["status"] == "PENDING":
                actions += (f'<form class=inline method=post action=/plan/accept>'
                            f'<input type=hidden name=plan_id value={p["id"]}>'
                            f'<button class="btn sm">确认时段开始</button></form>')
            rows_html += f"""
            <tr><td>#{p['id']} {cross}</td>
            <td>{esc(p['ename'])}<div class=dept>{esc(p['edept'])}</div></td>
            <td>{esc(p['mname'])}<div class=dept>{esc(p['mdept'])}</div></td>
            <td>{slot_txt}</td><td>{status_badge(p['status'])}</td>
            <td class=right>{actions}</td></tr>"""
        body = f"""
        <div class=card><table>
        <tr><th>计划</th><th>员工</th><th>导师</th><th>已排时段</th><th>状态</th><th></th></tr>
        {rows_html or '<tr><td colspan=6 class=muted>暂无辅导计划</td></tr>'}
        </table></div>"""
        if reqs:
            req_html = "".join(
                f'<tr><td>#{r["id"]}</td><td>{esc(r["skill"])}</td>'
                f'<td>{status_badge(r["status"])}</td>'
                f'<td>{esc(r["created_at"])}</td></tr>' for r in reqs)
            body += ("<h2>我的匹配申请</h2><div class=card><table>"
                     "<tr><th>申请</th><th>技能</th><th>状态</th><th>提交时间</th></tr>"
                     f"{req_html}</table></div>")
        self._page("时段安排 / 我的辅导", body, user, msg)

    # -- 辅导纪要 --
    def _load_plan_for_view(self, plan_id, user):
        conn = self.conn
        plan = conn.execute("SELECT * FROM plans WHERE id=?", (plan_id,)).fetchone()
        if plan is None:
            conn.close()
            raise svc.DomainError("NOT_FOUND", "计划不存在")
        return conn, plan

    def page_plan(self, plan_id, msg):
        user = self._require_login()
        if not user:
            return
        conn, plan = self._load_plan_for_view(plan_id, user)
        can_private = svc.can_view_private(conn, user, plan)
        is_party = user["id"] in (plan["employee_id"], plan["mentor_id"])
        entries = svc.visible_journal(conn, user, plan)
        emp = svc.get_user(conn, plan["employee_id"])
        men = svc.get_user(conn, plan["mentor_id"])

        goals = [e for e in entries if e["kind"] == "goal"]
        sessions = [e for e in entries if e["kind"] == "session"]
        privates = [e for e in entries if e["kind"] == "feedback_private"]

        def entry_html(e):
            kind_label = {"goal": "🎯 目标", "session": "📝 进展",
                          "feedback_private": "🔒 私密反馈"}[e["kind"]]
            return f"""<div class="entry kind-{e['kind']}">
              <b>{esc(e['title'])}</b> <span class=meta>{kind_label} ·
              {esc(svc.get_user(conn, e['author_id'])['name'])} ·
              {esc(e['created_at'])}{' · 目标日 ' + esc(e['target_date']) if e['target_date'] else ''}</span>
              <div>{esc(e['content'])}</div></div>"""

        tl = ""
        for e in goals:
            tl += f'<div class=tl><div class=date>🎯 {esc(e["target_date"] or "未定日期")}</div>{entry_html(e)}</div>'
        tl_session = "".join(entry_html(e) for e in sessions)
        if tl_session:
            tl += f'<h2 style="margin-left:8px">进展记录</h2><div style="margin-left:8px">{tl_session}</div>'

        if can_private:
            priv_html = "".join(entry_html(e) for e in privates) or \
                '<p class=muted>暂无私密反馈。</p>'
            private_card = f"""
            <div class=lock><h3>🔒 私密反馈区域</h3>
            <p class=meta muted style="margin:4px 0 10px">仅当事员工、导师及所属部门授权主管可见；
            每次查看均记入访问审计。</p>{priv_html}</div>"""
        else:
            private_card = """<div class=lock><h3>🔒 私密反馈区域</h3>
            <p class=muted>你不是该辅导的当事人或授权主管，私密反馈对你不可见，
            本次访问已记录到审计日志。</p></div>"""

        write_form = ""
        if is_party and plan["status"] in ("PENDING", "IN_PROGRESS"):
            write_form = f"""
            <div class=card><h2 style="margin-top:0">新增记录</h2>
            <form method=post action=/plan/journal>
            <input type=hidden name=plan_id value={plan['id']}>
            <label>类型</label>
            <select name=kind>
              <option value=goal>公开目标（双方与主管可见）</option>
              <option value=session>进展记录（公开）</option>
              <option value=feedback_private>私密反馈（仅当事人/授权主管）</option>
            </select>
            <label>标题</label><input type=text name=title required>
            <label>目标完成日期（仅目标需要）</label><input type=text name=target_date
              placeholder="YYYY-MM-DD">
            <label>内容</label><textarea name=content required></textarea>
            <p class=muted style="font-size:12.5px">反馈以登录身份提交，
            导师无法替员工提交、员工也无法替导师提交。</p>
            <button class=btn>提交</button></form></div>"""

        actions = ""
        if is_party and plan["status"] in ("PENDING", "IN_PROGRESS"):
            actions = f"""
            <div class=card><h2 style="margin-top:0">计划流转</h2><div class=row>
            <form method=post action=/plan/complete><input type=hidden name=plan_id
              value={plan['id']}>
              <input type=text name=reason placeholder="提前结项原因" required>
              <button class="btn ghost">申请提前结项</button></form>
            <a class="btn ghost" href="/transfer?plan={plan['id']}">申请换导师</a>
            </div></div>"""

        # 附件
        attach_html = ""
        try:
            atts = svc.list_attachments(conn, user, plan)
            links = "".join(
                f'<li>📎 <a href="/attachment?id={a["id"]}">{esc(a["filename"])}</a> '
                f'<span class=muted>{esc(a["uploader_name"])} · {esc(a["created_at"])}</span></li>'
                for a in atts)
            attach_html = (f'<div class=card><h2 style="margin-top:0">本地附件</h2>'
                           f'<ul>{links or "<span class=muted>无</span>"}</ul>'
                           + (f"""<form method=post action=/plan/attach>
                <input type=hidden name=plan_id value={plan['id']}>
                <input type=text name=filename placeholder="虚构附件文件名，如 阶段评估.txt">
                <button class="btn sm">生成并登记虚构附件</button></form>"""
                              if is_party else "") + "</div>")
        except svc.DomainError:
            attach_html = ""

        body = f"""
        <div class=card><div class=row spread>
          <div>员工 <b>{esc(emp['name'])}</b>（{esc(emp['department'])}）
          ⇄ 导师 <b>{esc(men['name'])}</b>（{esc(men['department'])}）
          {'<span class=tag>跨部门</span>' if plan['cross_dept'] else ''}</div>
          {status_badge(plan['status'])}</div>
          <div class=muted>计划 #{plan['id']} · 创建 {esc(plan['created_at'])}</div></div>
        <h2>🎯 目标时间线（公开）</h2>
        <div class=card><div class=timeline>{tl or '<p class=muted>还没有目标</p>'}</div></div>
        {private_card}
        {attach_html}
        {write_form}{actions}"""
        conn.close()
        self._page(f"辅导纪要 #{plan_id}", body, user, msg)

    def post_journal(self, user, form):
        plan_id = int(form["plan_id"])
        svc.add_journal(user["id"], plan_id, form["kind"],
                        form.get("title", ""), form.get("content", ""),
                        form.get("target_date") or None)
        self._redirect(f"/plan?id={plan_id}", "记录已提交")

    def post_accept(self, user, form):
        plan_id = int(form["plan_id"])
        svc.accept_plan(user["id"], plan_id)
        self._redirect(f"/plan?id={plan_id}", "时段已确认，辅导开始")

    def post_request_completion(self, user, form):
        plan_id = int(form["plan_id"])
        svc.request_completion(user["id"], plan_id, form.get("reason", ""))
        self._redirect(f"/plan?id={plan_id}", "提前结项申请已提交，等待主管审核")

    # -- 附件 --
    def post_attach(self, user, form):
        plan_id = int(form["plan_id"])
        filename = Path(form.get("filename", "")).name or "attachment.txt"
        if not re.fullmatch(r"[\w.\-一-龥]+", filename):
            filename = "attachment.txt"
        att_id = svc.add_attachment(user["id"], plan_id, filename)
        path = attachment_dir() / f"{att_id}_{filename}"
        path.write_text(
            f"【虚构附件】\n计划 #{plan_id}\n上传人: {user['name']}\n"
            "本文件为本地演示生成，无真实业务内容。\n", encoding="utf-8")
        self._redirect(f"/plan?id={plan_id}", f"虚构附件 {filename} 已生成")

    def page_download(self, att_id):
        user = self._require_login()
        if not user:
            return
        conn = self.conn
        att = conn.execute(
            "SELECT * FROM plan_attachments WHERE id=?", (att_id,)).fetchone()
        if att is None:
            conn.close()
            return self._error(user, 404, "附件不存在")
        plan = conn.execute("SELECT * FROM plans WHERE id=?", (att["plan_id"],)).fetchone()
        if user["id"] not in (plan["employee_id"], plan["mentor_id"]) \
                and not svc.can_view_private(conn, user, plan):
            svc.log_access(user["id"], "DOWNLOAD_ATTACHMENT", plan["id"], False,
                           "越权下载附件被拒绝")
            conn.close()
            return self._error(user, 403, "无权下载该附件")
        svc.log_access(user["id"], "DOWNLOAD_ATTACHMENT", plan["id"], True, "下载附件")
        path = attachment_dir() / f"{att['id']}_{att['filename']}"
        conn.close()
        if not path.exists():
            return self._error(user, 404, "附件文件缺失")
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition",
                         f'attachment; filename*=UTF-8\'\'{urllib.parse.quote(att["filename"])}')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # -- 换导师 --
    def page_transfer(self, msg):
        user = self._require_login()
        if not user:
            return
        conn = self.conn
        plans = conn.execute(
            "SELECT p.*, m.name mname FROM plans p JOIN users m ON m.id=p.mentor_id "
            "WHERE p.employee_id=? AND p.status IN ('PENDING','IN_PROGRESS')",
            (user["id"],)).fetchall()
        mine = conn.execute(
            "SELECT t.*, p.mentor_id, m.name mname FROM transfer_requests t "
            "JOIN plans p ON p.id=t.plan_id JOIN users m ON m.id=p.mentor_id "
            "WHERE t.employee_id=? ORDER BY t.id DESC", (user["id"],)).fetchall()
        mentors = svc.mentor_directory(conn)
        opts = "".join(
            f'<option value="{m["id"]}">{esc(m["name"])}（{esc(m["department"])}，'
            f'剩{m["remaining"]}）</option>' for m in mentors)
        plan_opts = "".join(
            f'<option value="{p["id"]}">#{p["id"]} 导师 {esc(p["mname"])}</option>'
            for p in plans)
        rows = "".join(
            f'<tr><td>#{t["id"]}</td><td>计划 #{t["plan_id"]}</td>'
            f'<td>{esc(t["reason"])}</td><td>{status_badge(t["status"])}</td>'
            f'<td>{esc(t["created_at"])}</td></tr>' for t in mine)
        body = f"""
        <div class=card><h2 style="margin-top:0">发起换导师申请</h2>
        <form method=post action=/transfer>
        <label>当前辅导计划</label><select name=plan_id>{plan_opts}</select>
        <label>原因</label><textarea name=reason required
          placeholder="如：时间难以协调、方向调整等"></textarea>
        <label>意向新导师（可选，最终由主管确认）</label>
        <select name=new_mentor_id><option value="">不指定</option>{opts}</select>
        <p style="margin-top:12px"><button class="btn">提交换导师申请</button></p>
        </form></div>
        <h2>我的换导师记录</h2>
        <div class=card><table>
        <tr><th>申请</th><th>计划</th><th>原因</th><th>状态</th><th>时间</th></tr>
        {rows or '<tr><td colspan=5 class=muted>暂无记录</td></tr>'}</table></div>
        <p class=muted>审批通过后，原计划立即废弃并释放时段/名额，系统生成新的待开始计划。
        导师离职时系统会自动发起改派申请。</p>"""
        conn.close()
        self._page("换导师", body, user, msg)

    def post_transfer(self, user, form):
        nm = form.get("new_mentor_id", "")
        svc.request_transfer(user["id"], int(form["plan_id"]),
                             form.get("reason", ""), int(nm) if nm else None)
        self._redirect("/transfer", "换导师申请已提交，等待主管审批")

    # -- 主管工作台 --
    def page_review(self, msg):
        user = self._require_login()
        if not user:
            return
        if user["role"] != "manager":
            return self._error(user, 403, "仅主管可访问工作台")
        conn = self.conn
        dept = user["department"]

        open_reqs = conn.execute(
            "SELECT r.*, u.name uname, u.department udept FROM match_requests r "
            "JOIN users u ON u.id=r.employee_id WHERE r.status='OPEN' "
            "AND u.department=?",
            (dept,)).fetchall()
        mentors = svc.mentor_directory(conn)
        req_rows = ""
        for r in open_reqs:
            slots = svc.parse_slots(r["slots"])
            slot_txt = " ".join(
                f'<span class=slotline>{WEEKDAYS[s["weekday"]]} {esc(s["period"])}</span>'
                for s in slots)
            mopts = "".join(
                f'<option value="{m["id"]}" {"disabled" if m["remaining"]<=0 else ""}>'
                f'{esc(m["name"])}｜{esc(m["expertise"])}｜'
                f'{"跨部门" if m["accepts_cross"] else "仅本部门"}｜剩{m["remaining"]}'
                '</option>' for m in mentors)
            req_rows += f"""
            <tr><td>#{r['id']}<div class=dept>{esc(r['uname'])}</div></td>
            <td><b>{esc(r['skill'])}</b><div class=muted>{esc(r['note'])}</div></td>
            <td>{slot_txt}</td>
            <td><form method=post action=/match class=row>
            <input type=hidden name=request_id value={r['id']}>
            <select name=mentor_id>{mopts}</select>
            <button class="btn sm">确认配对</button></form></td></tr>"""

        transfers = conn.execute(
            "SELECT t.*, e.name ename, e.department edept, m.name omname, m.department omdept, "
            "nm.name nmname FROM transfer_requests t "
            "JOIN users e ON e.id=t.employee_id JOIN plans p ON p.id=t.plan_id "
            "JOIN users m ON m.id=p.mentor_id "
            "LEFT JOIN users nm ON nm.id=t.new_mentor_id "
            "WHERE t.status='PENDING' AND (e.department=? OR m.department=?) ORDER BY t.id",
            (dept, dept)).fetchall()
        mopts = "".join(
            f'<option value="{m["id"]}">{esc(m["name"])}（{esc(m["department"])}，'
            f'剩{m["remaining"]}）</option>' for m in mentors)
        tr_rows = ""
        for t in transfers:
            tr_rows += f"""
            <tr><td>#{t['id']}<div class=dept>计划 #{t['plan_id']}</div></td>
            <td>{esc(t['ename'])}<div class=dept>{esc(t['edept'])}</div></td>
            <td>{esc(t['omname'])}<div class=dept>{esc(t['omdept'])}</div></td>
            <td>{esc(t['reason'])}</td>
            <td>{esc(t['nmname'] or '未指定')}</td>
            <td class=row>
            <form method=post action=/review/transfer>
            <input type=hidden name=transfer_id value={t['id']}>
            <input type=hidden name=decision value=approve>
            <select name=new_mentor_id>{f'<option value="">请选择接替导师</option>{mopts}'}</select>
            <button class="btn sm">批准改派</button></form>
            <form method=post action=/review/transfer>
            <input type=hidden name=transfer_id value={t['id']}>
            <input type=hidden name=decision value=reject>
            <button class="btn sm danger">驳回</button></form></td></tr>"""

        completions = conn.execute(
            "SELECT c.*, u.name uname, e.name ename, m.name mname, "
            "e.department edept, m.department mdept FROM completion_requests c "
            "JOIN users u ON u.id=c.requester_id JOIN plans p ON p.id=c.plan_id "
            "JOIN users e ON e.id=p.employee_id JOIN users m ON m.id=p.mentor_id "
            "WHERE c.status='PENDING' AND (e.department=? OR m.department=?) ORDER BY c.id",
            (dept, dept)).fetchall()
        cr_rows = ""
        for c in completions:
            cr_rows += f"""
            <tr><td>#{c['id']}<div class=dept>计划 #{c['plan_id']}</div></td>
            <td>{esc(c['uname'])}</td>
            <td>{esc(c['ename'])} ⇄ {esc(c['mname'])}</td>
            <td>{esc(c['reason'])}</td><td>{esc(c['created_at'])}</td>
            <td class=row><form method=post action=/review/completion>
            <input type=hidden name=completion_id value={c['id']}>
            <input type=hidden name=decision value=approve>
            <button class="btn sm">批准结项</button></form>
            <form method=post action=/review/completion>
            <input type=hidden name=completion_id value={c['id']}>
            <input type=hidden name=decision value=reject>
            <button class="btn sm danger">驳回</button></form></td></tr>"""

        mentor_users = [m for m in mentors]
        left_opts = "".join(
            f'<option value="{m["id"]}">{esc(m["name"])}（{esc(m["department"])}）</option>'
            for m in mentor_users)

        body = f"""
        <h2>待配对申请</h2>
        <div class=card><table>
        <tr><th>申请/员工</th><th>技能与备注</th><th>可交流时段</th><th>配对导师</th></tr>
        {req_rows or '<tr><td colspan=4 class=muted>暂无待配对申请</td></tr>'}</table>
        <p class=muted>下拉中展示每位导师的擅长领域、是否接受跨部门与剩余名额；
        技能不匹配、跨部门回避、时间全冲突或名额已满会在确认时被拒绝。</p></div>

        <h2>换导师审批</h2>
        <div class=card><table>
        <tr><th>申请</th><th>员工</th><th>现导师</th><th>原因</th><th>意向</th><th>操作</th></tr>
        {tr_rows or '<tr><td colspan=6 class=muted>暂无待审批换导师申请</td></tr>'}</table></div>

        <h2>结项审核（提前完成）</h2>
        <div class=card><table>
        <tr><th>申请</th><th>发起人</th><th>辅导</th><th>原因</th><th>时间</th><th>操作</th></tr>
        {cr_rows or '<tr><td colspan=6 class=muted>暂无待审核结项申请</td></tr>'}</table></div>

        <h2>导师离职处理</h2>
        <div class=card><form method=post action=/review/mentor-left class=row>
        <select name=mentor_id>{left_opts}</select>
        <button class="btn danger">标记离职并自动改派</button></form>
        <p class=muted>离职后其所有进行中计划自动生成改派申请并通知员工，
        目录不再展示，未处理的配对会被拦截。</p></div>"""
        conn.close()
        self._page("主管工作台", body, user, msg)

    def post_match(self, user, form):
        svc.match(user["id"], int(form["request_id"]), int(form["mentor_id"]))
        self._redirect("/review", "配对成功，已通知员工确认时段")

    def post_review_transfer(self, user, form):
        approve = form["decision"] == "approve"
        nm = form.get("new_mentor_id", "")
        new_pid = svc.review_transfer(
            user["id"], int(form["transfer_id"]), approve,
            int(nm) if nm else None)
        if approve:
            self._redirect("/review", f"已改派，新计划 #{new_pid} 待员工确认")
        self._redirect("/review", "换导师申请已驳回")

    def post_review_completion(self, user, form):
        svc.review_completion(user["id"], int(form["completion_id"]),
                              form["decision"] == "approve")
        self._redirect("/review", "结项审核完成")

    def post_mentor_left(self, user, form):
        ids = svc.mark_mentor_left(user["id"], int(form["mentor_id"]))
        self._redirect("/review",
                       f"导师已离职，生成 {len(ids)} 条改派申请并通知员工")

    # -- 消息回执 --
    def page_messages(self, msg):
        user = self._require_login()
        if not user:
            return
        conn = self.conn
        msgs = conn.execute(
            "SELECT * FROM messages WHERE receiver_id=? ORDER BY id DESC LIMIT 50",
            (user["id"],)).fetchall()
        rows = "".join(
            f'<tr><td>{m["id"]}</td><td><span class=tag>{esc(m["mtype"])}</span></td>'
            f'<td>{esc(m["body"])}</td><td>{status_badge(m["status"])}</td>'
            f'<td>{esc(m["created_at"])}</td></tr>' for m in msgs)
        body = f"""
        <p class=muted>模拟消息适配器：所有通知不真正外发，在此落库作为回执
        （SENT/READ）。</p>
        <div class=card><table>
        <tr><th>#</th><th>类型</th><th>内容</th><th>回执</th><th>时间</th></tr>
        {rows or '<tr><td colspan=5 class=muted>暂无消息</td></tr>'}</table></div>"""
        conn.close()
        self._page("消息回执", body, user, msg)


# 让 _form 保留多值: 包装表单读取
_orig_form = Handler._form


def _form_multi(self):
    length = int(self.headers.get("Content-Length", 0))
    raw = self.rfile.read(length).decode("utf-8") if length else ""
    parsed = urllib.parse.parse_qs(raw, keep_blank_values=True)
    self._raw_form = parsed
    return {k: v[0] for k, v in parsed.items()}


Handler._form = _form_multi


def serve(host: str = "127.0.0.1", port: int = 8000) -> None:
    init_db()
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"🌿 导师配对系统已启动: http://{host}:{port}")
    httpd.serve_forever()
