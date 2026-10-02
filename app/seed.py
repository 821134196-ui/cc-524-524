"""虚构演示数据。

覆盖案例:
  r6 小林 OPEN 申请(Python 后端)      -> 主管可配对
  p1 小苏-张伟 IN_PROGRESS            -> 目标时间线 + 双向私密反馈 + 本地附件
  p2 小冯-孙悦 PENDING(6 天前创建)    -> 长期未开始, 启动即提醒
  p3 小褚-吴芳 IN_PROGRESS + 换导师申请(意向李娜, 跨部门) -> 换导师案例
  p4 小卫-李娜 IN_PROGRESS + 提前结项申请               -> 结项审核案例
  p5 小蒋-郑强 IN_PROGRESS            -> 主管可演示"导师离职自动改派"
  r7 沈静 OPEN 申请(数据分析)         -> 仅市场部孙悦擅长且不接受跨部门(回避案例)
容量: 张伟 2(占1) 李娜 2(占1, 换导师后占2) 孙悦 1(占1=满)
      吴芳 2(占1) 郑强 1(占1=满)
"""
from __future__ import annotations

import json
from datetime import timedelta

from .db import DB_PATH, attachment_dir, get_conn, init_db
from .services import iso, now, remind_stale_plans


def _u(cur, name, dept, role, active=1):
    row = cur.execute(
        "INSERT INTO users(name,department,role,is_active) VALUES (?,?,?,?)",
        (name, dept, role, active))
    return row.lastrowid


def seed(fresh: bool = True) -> None:
    if fresh and DB_PATH.exists():
        for suffix in ("", "-wal", "-shm"):
            p = DB_PATH.with_name(DB_PATH.name + suffix)
            if p.exists():
                p.unlink()
    init_db()
    conn = get_conn()
    t = now()
    ts = lambda d=0: iso(t - timedelta(days=d))  # noqa: E731

    try:
        # ---- 用户 ----
        wang = _u(conn, "王敏", "工程部", "manager")
        chen = _u(conn, "陈立", "市场部", "manager")
        zhou = _u(conn, "周慧", "人事部", "manager")

        zhang = _u(conn, "张伟", "工程部", "mentor")
        li = _u(conn, "李娜", "工程部", "mentor")
        zheng = _u(conn, "郑强", "工程部", "mentor")
        sun = _u(conn, "孙悦", "市场部", "mentor")
        wu = _u(conn, "吴芳", "人事部", "mentor")

        lin = _u(conn, "林一帆", "工程部", "employee")
        su = _u(conn, "苏婷", "工程部", "employee")
        wei = _u(conn, "卫晨", "工程部", "employee")
        jiang = _u(conn, "蒋涛", "工程部", "employee")
        feng = _u(conn, "冯雪", "市场部", "employee")
        chu = _u(conn, "褚琳", "人事部", "employee")
        shen = _u(conn, "沈静", "人事部", "employee")

        # ---- 导师档案 ----
        conn.executemany(
            "INSERT INTO mentors(id,expertise,monthly_cap,dept,accepts_cross)"
            " VALUES (?,?,?,?,?)",
            [(zhang, "Python 后端,系统设计,代码评审", 2, "工程部", 0),
             (li, "前端工程,React,用户体验", 2, "工程部", 1),
             (zheng, "测试自动化,Python 后端", 1, "工程部", 0),
             (sun, "品牌策划,数据分析", 1, "市场部", 0),
             (wu, "招聘流程,员工关系,数据分析", 2, "人事部", 0)])

        # ---- 申请 ----
        def req(emp, skill, slots, status, note="", days=0):
            cur = conn.execute(
                "INSERT INTO match_requests(employee_id,skill,slots,note,status,"
                "created_at) VALUES (?,?,?,?,?,?)",
                (emp, skill, json.dumps(slots, ensure_ascii=False), note, status,
                 ts(days)))
            return cur.lastrowid

        r1 = req(su, "Python 后端",
                 [{"weekday": 1, "period": "19:00-20:00"}], "MATCHED",
                 "希望独立负责后端模块", 20)
        r2 = req(feng, "品牌策划",
                 [{"weekday": 3, "period": "18:00-19:00"}], "MATCHED",
                 "新接触品牌方向", 6)
        r3 = req(chu, "员工关系",
                 [{"weekday": 2, "period": "12:30-13:00"}], "MATCHED",
                 "想提升沟通能力", 18)
        r4 = req(wei, "前端工程",
                 [{"weekday": 4, "period": "19:30-20:30"}], "MATCHED",
                 "React 上手", 15)
        r5 = req(jiang, "测试自动化",
                 [{"weekday": 0, "period": "10:00-11:00"}], "MATCHED",
                 "", 12)
        r6 = req(lin, "Python 后端",
                 [{"weekday": 1, "period": "19:00-20:00"},
                  {"weekday": 3, "period": "12:30-13:00"}], "OPEN",
                 "校招新员工，想打好后端基础", 1)
        r7 = req(shen, "数据分析",
                 [{"weekday": 4, "period": "18:00-19:00"}], "OPEN",
                 "需要数据支撑招聘决策", 1)

        # ---- 计划 ----
        def plan(rid, emp, men, status, cross=0, days=0, accepted_days=None,
                 pred=None):
            cur = conn.execute(
                "INSERT INTO plans(request_id,employee_id,mentor_id,cross_dept,"
                "status,predecessor_plan_id,created_at,accepted_at)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (rid, emp, men, cross, status, pred, ts(days),
                 ts(accepted_days) if accepted_days is not None else None))
            return cur.lastrowid

        p1 = plan(r1, su, zhang, "IN_PROGRESS", days=19, accepted_days=18)
        p2 = plan(r2, feng, sun, "PENDING", days=6)
        p3 = plan(r3, chu, wu, "IN_PROGRESS", days=17, accepted_days=16)
        p4 = plan(r4, wei, li, "IN_PROGRESS", days=14, accepted_days=13)
        p5 = plan(r5, jiang, zheng, "IN_PROGRESS", days=11, accepted_days=10)

        # ---- 已排时段 ----
        conn.executemany(
            "INSERT INTO schedule_slots(plan_id,mentor_id,employee_id,weekday,"
            "period,active) VALUES (?,?,?,?,?,1)",
            [(p1, zhang, su, 1, "19:00-20:00"),
             (p3, wu, chu, 2, "12:30-13:00"),
             (p4, li, wei, 4, "19:30-20:30"),
             (p5, zheng, jiang, 0, "10:00-11:00")])

        # ---- p1 纪要: 公开目标时间线 + 进展 + 双向私密反馈 ----
        conn.executemany(
            "INSERT INTO journal_entries(plan_id,kind,author_id,author_role,"
            "title,content,target_date,created_at) VALUES (?,?,?,?,?,?,?,?)",
            [(p1, "goal", zhang, "mentor", "掌握服务分层与依赖注入",
              "能独立讲清 controller/service/repository 的边界，"
              "并在示例项目中落地。", "2026-10-20", ts(17)),
             (p1, "session", zhang, "mentor", "第一次沟通：学习路径梳理",
              "确认了三个月学习路线，先补 Web 框架与数据库基础。",
              None, ts(17)),
             (p1, "goal", su, "employee", "完成两次代码评审练习",
              "各提交一次小模块 PR，根据评审意见修改并复盘。",
              "2026-11-05", ts(16)),
             (p1, "session", su, "employee", "第二次沟通：PR 复盘",
              "第一次评审暴露了异常处理不统一的问题，已按建议收敛。",
              None, ts(8)),
             (p1, "feedback_private", zhang, "mentor",
              "对小苏的阶段性印象（私密）",
              "基础扎实、上手快；建议更主动地在站会上同步风险。",
              None, ts(8)),
             (p1, "feedback_private", su, "employee",
              "对张伟导师的反馈（私密）",
              "讲解清晰、案例贴切；希望后续能安排更多真实需求的实战任务。",
              None, ts(7))])

        # ---- p3 换导师申请（启动即存在的换导师案例）----
        conn.execute(
            "INSERT INTO transfer_requests(plan_id,employee_id,reason,"
            "new_mentor_id,status,created_at) VALUES (?,?,?,?,'PENDING',?)",
            (p3, chu, "部门排班调整后，每周二午间时段长期冲突；"
             "李娜导师接受跨部门且时段匹配，申请换导师。", li, ts(3)))

        # ---- p4 提前结项申请 ----
        conn.execute(
            "INSERT INTO completion_requests(plan_id,requester_id,reason,status,"
            "created_at) VALUES (?,?,?, 'PENDING',?)",
            (p4, wei, "React 学习目标已全部达成，独立完成了两个页面，"
             "申请提前结项。", ts(1)))

        # ---- p1 虚构附件 ----
        cur = conn.execute(
            "INSERT INTO plan_attachments(plan_id,filename,uploaded_by,created_at)"
            " VALUES (?,?,?,?)",
            (p1, "阶段学习目标.txt", zhang, ts(16)))
        att_id = cur.lastrowid
        (attachment_dir() / f"{att_id}_阶段学习目标.txt").write_text(
            "【虚构附件】企业导师配对系统演示用\n"
            "计划：苏婷 ⇄ 张伟（Python 后端）\n"
            "阶段目标：服务分层、代码评审、异常处理统一\n"
            "本文件为本地虚构内容，无真实业务数据。\n", encoding="utf-8")

        conn.commit()

        # ---- 启动时先发一条配对回执样例消息 ----
        conn.execute(
            "INSERT INTO messages(receiver_id,mtype,body,status,created_at)"
            " VALUES (?,?,?,?,?)",
            (su, "MATCH", "主管 王敏 已为你配对导师 张伟（Python 后端），"
             "请确认时段安排。", "READ", ts(19)))
        conn.commit()
    finally:
        conn.close()

    # 长期未开始计划: 启动扫描一次, p2 会收到 STALE_PENDING 提醒
    remind_stale_plans()
