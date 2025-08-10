import os
import re
from pathlib import Path
from config.settings import Config

def get_project_root():
    return Path(__file__).resolve().parent.parent.parent

def resolve_path(path: str, config: Config = None) -> str:
    """将配置中的 ${VAR} 替换为实际路径，支持多级变量"""
    if config is None:
        config = Config()
    env = {
        "PROJECT_ROOT": str(get_project_root())
    }
    # 展开 settings.yaml 的所有一级和多级变量
    def flatten(d, prefix=''):
        items = {}
        for k, v in d.items():
            key = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                items.update(flatten(v, key))
            else:
                items[key] = str(v)
        return items
    env.update(flatten(config.settings))
    # 替换 ${VAR} 或 ${a.b.c}
    def replacer(match):
        var = match.group(1)
        return env.get(var, match.group(0))
    return re.sub(r"\$\{([a-zA-Z0-9_.]+)\}", replacer, path)