"""
批量处理工具模块

提供用户友好的批量视频处理接口，调用核心功能实现批量操作。
"""

# 处理导入
try:
    from .batch_processor import BatchProcessor
    from .batch_cli import BatchCLI
except ImportError:
    # 如果相对导入失败，尝试绝对导入
    import sys
    from pathlib import Path
    
    # 添加当前目录到路径
    current_dir = str(Path(__file__).parent)
    if current_dir not in sys.path:
        sys.path.insert(0, current_dir)
    
    try:
        from batch_processor import BatchProcessor
        from batch_cli import BatchCLI
    except ImportError as e:
        print(f"警告: 批量处理模块导入失败 - {e}")
        BatchProcessor = None
        BatchCLI = None

__all__ = ['BatchProcessor', 'BatchCLI'] 