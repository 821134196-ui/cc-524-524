"""企业导师配对系统 (Mentor Match)

业务流转:
  申请(mentor_match_request) -> 主管配对(match: plan PENDING)
    -> 员工确认时段 -> IN_PROGRESS -> 双方写纪要(公开目标/私密反馈)
    -> 任一方提前申请结项 -> 主管审核 -> COMPLETED
  异常: 换导师申请(transfer_request)、导师离职、跨部门回避、
        时间冲突、长期未开始(进程内提醒任务)。
"""
