import threading
import queue
import time
import psutil

class DynamicWorkerPool:
    def __init__(self, min_workers=1, max_workers=8, target_cpu=80, check_interval=5):
        self.min_workers = min_workers
        self.max_workers = max_workers
        self.target_cpu = target_cpu  # 目标最大CPU占用百分比
        self.check_interval = check_interval
        self.task_queue = queue.Queue()
        self.workers = []
        self.lock = threading.Lock()
        self.running = True

    def worker(self):
        while self.running:
            try:
                func, args, kwargs = self.task_queue.get(timeout=1)
                try:
                    func(*args, **kwargs)
                finally:
                    self.task_queue.task_done()
            except queue.Empty:
                continue

    def start(self, initial_workers):
        for _ in range(initial_workers):
            t = threading.Thread(target=self.worker, daemon=True)
            t.start()
            self.workers.append(t)
        threading.Thread(target=self.adjust_workers, daemon=True).start()

    def adjust_workers(self):
        while self.running:
            cpu = psutil.cpu_percent(interval=1)
            with self.lock:
                n = len(self.workers)
                if cpu > self.target_cpu and n > self.min_workers:
                    # 降低worker数
                    self.workers.pop()
                elif cpu < self.target_cpu * 0.7 and n < self.max_workers:
                    # 增加worker数
                    t = threading.Thread(target=self.worker, daemon=True)
                    t.start()
                    self.workers.append(t)
            time.sleep(self.check_interval)

    def submit(self, func, *args, **kwargs):
        self.task_queue.put((func, args, kwargs))

    def join(self):
        self.task_queue.join()
        self.running = False 