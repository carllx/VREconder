"""
VREconder Tools Package
用户友好的工具模块集合

这个包提供用户友好的工具接口，调用核心src/模块实现功能。
遵循清晰的架构层次：tools/ → src/main.py → src/modules
"""

__version__ = "1.0.0"
__author__ = "VREconder Team"

# 导出主要工具类
try:
    from .batch import BatchProcessor, BatchCLI
    from .maintenance import FFmpegChecker, SystemDiagnose, ConfigValidator
    from .deployment import DependencyInstaller, EnvironmentSetup
    
    __all__ = [
        'BatchProcessor', 'BatchCLI',
        'FFmpegChecker', 'SystemDiagnose', 'ConfigValidator', 
        'DependencyInstaller', 'EnvironmentSetup'
    ]
except ImportError as e:
    # 如果导入失败，提供友好的错误信息
    import sys
    import traceback
    print(f"警告: 工具模块导入失败 - {e}")
    print("请确保src/目录在Python路径中")
    __all__ = [] 