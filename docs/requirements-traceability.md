# 需求追踪矩阵

| 说明书需求 | 原型实现 | 验证方式 |
| --- | --- | --- |
| 接收 A-OCS 航班事件，触发重调度 | `POST /api/events`，含事件去重和四类事件校验 | 调用接口并检查 `assignments` |
| 车辆位置、油量、负载、航班优先级和时间窗约束 | `Scheduler.optimize` 按优先级排序，油量与可用状态硬约束，示意坐标距离排序 | 对低油量车辆或维修车改派，检查拒绝结果 |
| 人工调整、改派、加锁 | `POST /api/tasks/{id}/override` 和调度台“改派” | 改派后工单 `locked=1` |
| 下发工单与司机进度回传 | 调度台工单操作及 `POST /api/tasks/{id}/progress` | 验证 PENDING → IN_PROGRESS → COMPLETED |
| 异常必须记录原因码 | `EXCEPTION` 未带 `reason` 时返回 422 | 提交空原因，检查明确错误 |
| 油量不足、冲突等风险告警 | `alerts` 表和风险预警面板 | 无合格车辆时生成 CRITICAL 告警 |
| 统计与复盘 | 指挥台展示利用率、保障率、活动工单和风险 | 检查 `/api/overview.stats` |
| 可插拔 A-OCS 适配和算法扩展 | JSON API 边界，`Scheduler` 独立类，生产依赖清单 | 替换 Scheduler 实现不影响 Handler |
| 三类用户职责隔离 | 账号密码登录、权限自动分流、服务端会话令牌校验 | 司机访问 `/api/overview` 返回 403，司机工单按车辆过滤 |
| 航班计划导入 | 管理员 CSV/JSON 导入界面与 `/api/admin/flights/import` | 管理员导入后在航班计划表看到新增或更新记录 |
