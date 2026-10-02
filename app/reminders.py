"""进程内提醒任务: 守护线程定时扫描长期未开始的辅导计划。

不依赖外部调度器; 测试中可直接调用 services.remind_stale_plans()。
"""
from __future__ import annotations

import threading
import time

from .services import remind_stale_plans


class ReminderScheduler:
    def __init__(self, interval_seconds: float = 60.0):
        self.interval = interval_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.lock = threading.Lock()
        self.runs = 0

    def _loop(self) -> None:
        while not self._stop.wait(self.interval):
            with self.lock:
                try:
                    remind_stale_plans()
                except Exception:
                    pass
                self.runs += 1

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="mentor-reminder",
                                        daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
