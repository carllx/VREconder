import os
import time
from typing import Optional, Dict

class ProgressLogger:
    def __init__(self, log_path: str, task_id: Optional[str] = None):
        self.log_path = log_path
        self.task_id = task_id
        # 确保日志目录存在
        os.makedirs(os.path.dirname(log_path), exist_ok=True)

    def write(self, line: str):
        with open(self.log_path, 'a', encoding='utf-8') as f:
            f.write(line)
            f.flush()  # 强制立即写盘

    def format_and_write(self, line: str):
        prefix = f"[{self.task_id}] " if self.task_id else ""
        self.write(prefix + line)


def monitor_progress(log_files: Dict[str, str], interval: float = 2.0, stop_flag=None):
    """
    增量读取每个日志文件的新行，遇到包含 speed=、frame=、time= 的行就输出。
    log_files: {task_id: log_path}
    interval: 轮询间隔秒数
    stop_flag: 可选的 threading.Event()，用于优雅退出
    """
    file_offsets = {tid: 0 for tid in log_files}
    while True:
        if stop_flag and stop_flag.is_set():
            break
        # 修复：遍历前先list()化，防止字典变动导致RuntimeError
        for tid, log in list(log_files.items()):
            try:
                with open(log, 'r', encoding='utf-8') as f:
                    f.seek(file_offsets.get(tid, 0))
                    while True:
                        line = f.readline()
                        if not line:
                            break
                        if any(k in line for k in ("speed=", "frame=", "time=")):
                            print(f"[{tid}] {line.strip()}", flush=True)
                    file_offsets[tid] = f.tell()
            except Exception:
                pass
        time.sleep(interval)


def tail_ffmpeg_log(log_path, segment_index=None, stop_event=None, interval=0.5):
    """
    实时监控单个FFmpeg日志文件，输出 frame/time/speed 信息。
    """
    last_print = None
    import re
    while not (stop_event and stop_event.is_set()):
        try:
            if not os.path.exists(log_path):
                time.sleep(interval)
                continue
            with open(log_path, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
            for line in reversed(lines):
                m = re.search(r'.*frame=\s*(\d+).*?time=([\d:.]+).*?speed=([\d.]+x)', line)
                if m:
                    frame, t, speed = m.groups()
                    progress_str = f"[segment_{segment_index}] frame={frame} time={t} speed={speed}" if segment_index is not None else f"frame={frame} time={t} speed={speed}"
                    if progress_str != last_print:
                        print(progress_str, flush=True)
                        last_print = progress_str
                    break
        except Exception:
            pass
        time.sleep(interval) 