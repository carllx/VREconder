#!/usr/bin/env python3
"""
系统诊断工具
检查系统环境、硬件信息和配置状态
"""
import sys
import platform
import subprocess
import psutil
import argparse
import logging
from pathlib import Path
from typing import Dict, Any, Optional

# 添加src到路径
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from config.settings import Config


class SystemDiagnose:
    """系统诊断工具"""
    
    def __init__(self, config_file: Optional[str] = None):
        self.config = Config(config_file)
        self.logger = logging.getLogger(__name__)
    
    def diagnose_system(self) -> Dict[str, Any]:
        """诊断系统环境"""
        print("🖥️  系统环境诊断")
        print("=" * 50)
        
        info = {}
        
        # 基本系统信息
        print("📋 基本信息:")
        info['platform'] = platform.platform()
        info['system'] = platform.system()
        info['machine'] = platform.machine()
        info['processor'] = platform.processor()
        
        print(f"   系统: {info['platform']}")
        print(f"   架构: {info['machine']}")
        print(f"   处理器: {info['processor']}")
        
        # 内存信息
        memory = psutil.virtual_memory()
        info['memory'] = {
            'total': memory.total,
            'available': memory.available,
            'percent': memory.percent
        }
        print(f"   内存: {memory.total // (1024**3)} GB 总量, {memory.available // (1024**3)} GB 可用 ({memory.percent:.1f}% 已使用)")
        
        # CPU信息
        info['cpu'] = {
            'count': psutil.cpu_count(),
            'physical': psutil.cpu_count(logical=False)
        }
        print(f"   CPU: {info['cpu']['physical']} 物理核心, {info['cpu']['count']} 逻辑核心")
        
        # 磁盘信息
        print("\n💾 磁盘空间:")
        info['disks'] = []
        for partition in psutil.disk_partitions():
            try:
                usage = psutil.disk_usage(partition.mountpoint)
                disk_info = {
                    'device': partition.device,
                    'mountpoint': partition.mountpoint,
                    'fstype': partition.fstype,
                    'total': usage.total,
                    'used': usage.used,
                    'free': usage.free,
                    'percent': (usage.used / usage.total) * 100
                }
                info['disks'].append(disk_info)
                print(f"   {partition.device}: {usage.free // (1024**3)} GB 可用 / {usage.total // (1024**3)} GB 总量")
            except PermissionError:
                continue
        
        return info
    
    def check_gpu_support(self) -> Dict[str, Any]:
        """检查GPU硬件编码支持"""
        print("\n🎮 GPU硬件编码支持:")
        print("-" * 30)
        
        gpu_info = {
            'nvidia': False,
            'intel': False,
            'amd': False,
            'details': []
        }
        
        try:
            # 检查NVIDIA GPU
            try:
                result = subprocess.run(['nvidia-smi', '-L'], 
                                      capture_output=True, text=True, timeout=10)
                if result.returncode == 0:
                    gpu_info['nvidia'] = True
                    lines = result.stdout.strip().split('\n')
                    for line in lines:
                        if 'GPU' in line:
                            gpu_info['details'].append(f"NVIDIA: {line.strip()}")
                            print(f"   ✅ {line.strip()}")
            except (FileNotFoundError, subprocess.TimeoutExpired):
                print("   ❌ NVIDIA GPU: 未检测到或驱动未安装")
            
            # 检查Intel集显
            try:
                if platform.system() == "Windows":
                    result = subprocess.run(['wmic', 'path', 'win32_VideoController', 'get', 'name'], 
                                          capture_output=True, text=True, timeout=10)
                    if result.returncode == 0 and 'Intel' in result.stdout:
                        gpu_info['intel'] = True
                        gpu_info['details'].append("Intel: 集成显卡检测到")
                        print("   ✅ Intel QuickSync: 可能支持")
                    else:
                        print("   ❌ Intel QuickSync: 未检测到Intel显卡")
                else:
                    # Linux/macOS的检测方法
                    result = subprocess.run(['lspci'], capture_output=True, text=True, timeout=10)
                    if result.returncode == 0 and 'Intel' in result.stdout:
                        gpu_info['intel'] = True
                        gpu_info['details'].append("Intel: 集成显卡检测到")
                        print("   ✅ Intel QuickSync: 可能支持")
            except (FileNotFoundError, subprocess.TimeoutExpired):
                print("   ⚠️  Intel QuickSync: 无法检测")
            
            # 检查AMD GPU
            try:
                if platform.system() == "Windows":
                    result = subprocess.run(['wmic', 'path', 'win32_VideoController', 'get', 'name'], 
                                          capture_output=True, text=True, timeout=10)
                    if result.returncode == 0 and ('AMD' in result.stdout or 'Radeon' in result.stdout):
                        gpu_info['amd'] = True
                        gpu_info['details'].append("AMD: 显卡检测到")
                        print("   ✅ AMD AMF: 可能支持")
                    else:
                        print("   ❌ AMD AMF: 未检测到AMD显卡")
            except (FileNotFoundError, subprocess.TimeoutExpired):
                print("   ⚠️  AMD AMF: 无法检测")
                
        except Exception as e:
            print(f"   ⚠️  GPU检测失败: {e}")
        
        return gpu_info
    
    def check_dependencies(self) -> Dict[str, Any]:
        """检查Python依赖"""
        print("\n📦 Python依赖检查:")
        print("-" * 30)
        
        dependencies = {
            'python_version': sys.version,
            'packages': {}
        }
        
        print(f"   Python版本: {sys.version.split()[0]}")
        
        # 检查必要的包
        required_packages = [
            'psutil', 'yaml', 'pathlib', 
            'subprocess', 'concurrent.futures', 'threading'
        ]
        
        optional_packages = [
            'numpy', 'opencv-python', 'pillow'
        ]
        
        print("   必要依赖:")
        for package in required_packages:
            try:
                __import__(package)
                dependencies['packages'][package] = 'installed'
                print(f"     ✅ {package}")
            except ImportError:
                dependencies['packages'][package] = 'missing'
                print(f"     ❌ {package} (缺失)")
        
        print("   可选依赖:")
        for package in optional_packages:
            try:
                __import__(package)
                dependencies['packages'][package] = 'installed'
                print(f"     ✅ {package}")
            except ImportError:
                dependencies['packages'][package] = 'missing'
                print(f"     ⚠️  {package} (可选)")
        
        return dependencies
    
    def check_project_structure(self) -> Dict[str, Any]:
        """检查项目结构"""
        print("\n📁 项目结构检查:")
        print("-" * 30)
        
        project_root = Path(__file__).parent.parent.parent
        structure = {
            'root': str(project_root),
            'missing_files': [],
            'missing_dirs': []
        }
        
        # 检查必要的目录
        required_dirs = [
            'src', 'src/config', 'src/encoders', 'src/processors', 
            'src/utils', 'config', 'tools'
        ]
        
        # 检查必要的文件
        required_files = [
            'src/main.py', 'src/config/settings.py',
            'config/settings.yaml', 'requirements.txt'
        ]
        
        print("   必要目录:")
        for dir_name in required_dirs:
            dir_path = project_root / dir_name
            if dir_path.exists():
                print(f"     ✅ {dir_name}/")
            else:
                structure['missing_dirs'].append(dir_name)
                print(f"     ❌ {dir_name}/")
        
        print("   必要文件:")
        for file_name in required_files:
            file_path = project_root / file_name
            if file_path.exists():
                size_kb = file_path.stat().st_size / 1024
                print(f"     ✅ {file_name} ({size_kb:.1f} KB)")
            else:
                structure['missing_files'].append(file_name)
                print(f"     ❌ {file_name}")
        
        return structure
    
    def create_parser(self) -> argparse.ArgumentParser:
        """创建命令行参数解析器"""
        parser = argparse.ArgumentParser(
            description="VREconder 系统诊断工具",
            formatter_class=argparse.RawDescriptionHelpFormatter
        )
        
        parser.add_argument(
            '--full', 
            action='store_true',
            help='执行完整诊断'
        )
        parser.add_argument(
            '--gpu-only', 
            action='store_true',
            help='仅检查GPU支持'
        )
        parser.add_argument(
            '--deps-only', 
            action='store_true',
            help='仅检查依赖'
        )
        parser.add_argument(
            '--verbose', '-v', 
            action='store_true',
            help='详细输出'
        )
        
        return parser
    
    def main(self, argv=None):
        """主函数"""
        parser = self.create_parser()
        args = parser.parse_args(argv)
        
        # 设置日志
        level = logging.DEBUG if args.verbose else logging.INFO
        logging.basicConfig(level=level, format='%(levelname)s: %(message)s')
        
        try:
            if args.gpu_only:
                self.check_gpu_support()
            elif args.deps_only:
                self.check_dependencies()
            else:
                # 执行完整诊断
                system_info = self.diagnose_system()
                gpu_info = self.check_gpu_support()
                deps_info = self.check_dependencies()
                
                if args.full:
                    structure_info = self.check_project_structure()
                
                print("\n" + "=" * 50)
                print("✅ 系统诊断完成")
                
                # 显示建议
                suggestions = []
                
                if system_info['memory']['available'] < 4 * 1024**3:  # 小于4GB
                    suggestions.append("建议至少4GB可用内存用于视频处理")
                
                if not any([gpu_info['nvidia'], gpu_info['intel'], gpu_info['amd']]):
                    suggestions.append("未检测到硬件编码支持，将使用软件编码")
                
                if suggestions:
                    print("\n💡 建议:")
                    for suggestion in suggestions:
                        print(f"   - {suggestion}")
            
            return 0
            
        except KeyboardInterrupt:
            print("\n⚠️  用户中断操作")
            return 130
        except Exception as e:
            print(f"\n❌ 诊断过程出错: {e}")
            if args.verbose:
                import traceback
                traceback.print_exc()
            return 1


def main():
    """入口点函数"""
    diagnose = SystemDiagnose()
    sys.exit(diagnose.main())


if __name__ == "__main__":
    main() 