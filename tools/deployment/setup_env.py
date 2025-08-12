#!/usr/bin/env python3
"""
环境配置工具
自动配置VREconder项目的运行环境
"""
import sys
import os
import subprocess
import argparse
import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# 添加src到路径
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from config.settings import Config


class EnvironmentSetup:
    """环境配置工具"""
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.project_root = Path(__file__).parent.parent.parent
    
    def create_directories(self) -> bool:
        """创建必要的目录"""
        print("📁 创建项目目录结构...")
        
        directories = [
            'temp',
            'output', 
            'logs',
            'downloads',
            'config'
        ]
        
        success = True
        for dir_name in directories:
            dir_path = self.project_root / dir_name
            try:
                dir_path.mkdir(exist_ok=True)
                print(f"   ✅ {dir_name}/")
            except Exception as e:
                print(f"   ❌ {dir_name}/: {e}")
                success = False
        
        return success
    
    def setup_config_file(self) -> bool:
        """设置配置文件"""
        print("\n⚙️  配置文件设置...")
        
        config_file = self.project_root / "config" / "settings.yaml"
        
        if config_file.exists():
            print(f"   ✅ 配置文件已存在: {config_file}")
            return True
        
        # 创建基本配置文件
        sample_config = """# VREconder 配置文件
app:
  name: "VR Video Processing Pipeline"
  version: "2.0.0"
  debug: false

paths:
  download: "./downloads"
  output: "./output"
  temp: "./temp"
  logs: "./logs"
  
  # 平台特定路径
  windows:
    ffmpeg_path: "C:/ffmpeg/bin/ffmpeg.exe"
  macos:
    ffmpeg_path: "/usr/local/bin/ffmpeg"
  linux:
    ffmpeg_path: "/usr/bin/ffmpeg"

encoding:
  hevc:
    preset: "slower"
    crf_range:
      min: 20
      max: 38
    profile: "main10"

processing:
  max_workers: 4
  batch_size: 10
  timeout: 3600

network:
  share_name: "VR_Project"
  access_script_auto_create: true
"""
        
        try:
            config_file.parent.mkdir(exist_ok=True)
            with open(config_file, 'w', encoding='utf-8') as f:
                f.write(sample_config)
            print(f"   ✅ 配置文件创建成功: {config_file}")
            return True
        except Exception as e:
            print(f"   ❌ 配置文件创建失败: {e}")
            return False
    
    def detect_and_configure_ffmpeg(self) -> bool:
        """检测并配置FFmpeg"""
        print("\n🎬 FFmpeg环境配置...")
        
        # 尝试导入FFmpeg检测器
        try:
            from utils.ffmpeg_detector import FFmpegDetector
            from config.settings import Config
            
            config = Config()
            detector = FFmpegDetector(config)
            
            # 尝试检测FFmpeg
            try:
                ffmpeg_path = detector.detect_ffmpeg_path()
                print(f"   ✅ FFmpeg已找到: {ffmpeg_path}")
                
                # 测试FFmpeg功能
                is_working, version_info = detector.test_ffmpeg_installation()
                if is_working:
                    print(f"   ✅ FFmpeg功能正常: {version_info.split()[0] if version_info else '未知版本'}")
                    return True
                else:
                    print(f"   ❌ FFmpeg功能异常: {version_info}")
                    return False
                    
            except FileNotFoundError:
                print("   ❌ FFmpeg未找到")
                self._show_ffmpeg_install_instructions()
                return False
                
        except ImportError as e:
            print(f"   ❌ 无法导入FFmpeg检测器: {e}")
            return False
    
    def _show_ffmpeg_install_instructions(self):
        """显示FFmpeg安装说明"""
        import platform
        system = platform.system().lower()
        
        print("\n💡 FFmpeg安装指南:")
        
        if system == "windows":
            print("   Windows:")
            print("   1. 访问: https://ffmpeg.org/download.html")
            print("   2. 下载Windows构建版本")
            print("   3. 解压到 C:\\ffmpeg\\")
            print("   4. 将 C:\\ffmpeg\\bin\\ 添加到系统PATH")
            print("   或者使用包管理器:")
            print("   - Chocolatey: choco install ffmpeg")
            print("   - Scoop: scoop install ffmpeg")
        elif system == "darwin":
            print("   macOS:")
            print("   - Homebrew: brew install ffmpeg")
            print("   - MacPorts: sudo port install ffmpeg")
        else:
            print("   Linux:")
            print("   - Ubuntu/Debian: sudo apt install ffmpeg")
            print("   - CentOS/RHEL: sudo dnf install ffmpeg")
            print("   - Snap: sudo snap install ffmpeg")
    
    def setup_python_path(self) -> bool:
        """设置Python路径"""
        print("\n🐍 Python环境配置...")
        
        # 检查项目是否在Python路径中
        src_path = str(self.project_root / "src")
        
        if src_path in sys.path:
            print("   ✅ 项目路径已在Python路径中")
            return True
        
        # 创建.pth文件（如果在site-packages中）
        try:
            import site
            user_site = site.getusersitepackages()
            
            if user_site and Path(user_site).exists():
                pth_file = Path(user_site) / "vreconder.pth"
                with open(pth_file, 'w') as f:
                    f.write(str(self.project_root / "src"))
                print(f"   ✅ 创建Python路径文件: {pth_file}")
                return True
            else:
                print("   ⚠️  无法自动配置Python路径")
                print("   请手动将以下路径添加到PYTHONPATH:")
                print(f"   {src_path}")
                return False
                
        except Exception as e:
            print(f"   ❌ Python路径配置失败: {e}")
            return False
    
    def test_installation(self) -> bool:
        """测试安装"""
        print("\n🧪 测试安装...")
        
        success = True
        
        # 测试核心模块导入
        test_modules = [
            ('config.settings', 'Config'),
            ('utils.ffmpeg_detector', 'FFmpegDetector'),
            ('encoders.hevc_encoder', 'HEVCEncoder'),
            ('processors.video_splitter', 'VideoSplitter')
        ]
        
        for module_name, class_name in test_modules:
            try:
                module = __import__(module_name, fromlist=[class_name])
                getattr(module, class_name)
                print(f"   ✅ {module_name}.{class_name}")
            except ImportError as e:
                print(f"   ❌ {module_name}.{class_name}: 导入失败")
                success = False
            except AttributeError as e:
                print(f"   ❌ {module_name}.{class_name}: 类不存在")
                success = False
        
        # 测试主入口
        main_script = self.project_root / "src" / "main.py"
        if main_script.exists():
            print("   ✅ src/main.py")
        else:
            print("   ❌ src/main.py: 文件不存在")
            success = False
        
        # 测试tools模块
        tools_modules = [
            'tools.batch.batch_processor',
            'tools.maintenance.ffmpeg_checker'
        ]
        
        for module_name in tools_modules:
            try:
                __import__(module_name)
                print(f"   ✅ {module_name}")
            except ImportError:
                print(f"   ❌ {module_name}: 导入失败")
                success = False
        
        return success
    
    def create_startup_scripts(self) -> bool:
        """创建启动脚本"""
        print("\n📜 创建启动脚本...")
        
        scripts = []
        
        # Windows批处理脚本
        if os.name == 'nt':
            batch_script = self.project_root / "start_vreconder.bat"
            batch_content = f"""@echo off
cd /d "{self.project_root}"
python src/main.py %*
pause
"""
            scripts.append((batch_script, batch_content))
        
        # Unix shell脚本
        shell_script = self.project_root / "start_vreconder.sh"
        shell_content = f"""#!/bin/bash
cd "{self.project_root}"
python src/main.py "$@"
"""
        scripts.append((shell_script, shell_content))
        
        success = True
        for script_path, script_content in scripts:
            try:
                with open(script_path, 'w', encoding='utf-8') as f:
                    f.write(script_content)
                
                # 设置可执行权限（Unix系统）
                if script_path.suffix == '.sh':
                    script_path.chmod(0o755)
                
                print(f"   ✅ {script_path.name}")
            except Exception as e:
                print(f"   ❌ {script_path.name}: {e}")
                success = False
        
        return success
    
    def create_parser(self) -> argparse.ArgumentParser:
        """创建命令行参数解析器"""
        parser = argparse.ArgumentParser(
            description="VREconder 环境配置工具",
            formatter_class=argparse.RawDescriptionHelpFormatter,
            epilog="""
示例:
  # 完整环境设置
  python %(prog)s --setup-all
  
  # 仅创建目录
  python %(prog)s --create-dirs
  
  # 仅配置FFmpeg
  python %(prog)s --setup-ffmpeg
  
  # 测试安装
  python %(prog)s --test-only
            """
        )
        
        parser.add_argument(
            '--setup-all', 
            action='store_true',
            help='执行完整的环境设置'
        )
        parser.add_argument(
            '--create-dirs', 
            action='store_true',
            help='创建项目目录'
        )
        parser.add_argument(
            '--setup-config', 
            action='store_true',
            help='设置配置文件'
        )
        parser.add_argument(
            '--setup-ffmpeg', 
            action='store_true',
            help='配置FFmpeg'
        )
        parser.add_argument(
            '--create-scripts', 
            action='store_true',
            help='创建启动脚本'
        )
        parser.add_argument(
            '--test-only', 
            action='store_true',
            help='仅测试安装'
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
            print("🚀 VREconder 环境配置工具")
            print("=" * 50)
            
            success = True
            
            if args.setup_all:
                # 完整设置
                success &= self.create_directories()
                success &= self.setup_config_file()
                success &= self.detect_and_configure_ffmpeg()
                success &= self.setup_python_path()
                success &= self.create_startup_scripts()
                success &= self.test_installation()
                
            elif args.test_only:
                success = self.test_installation()
                
            else:
                # 按需设置
                if args.create_dirs:
                    success &= self.create_directories()
                
                if args.setup_config:
                    success &= self.setup_config_file()
                
                if args.setup_ffmpeg:
                    success &= self.detect_and_configure_ffmpeg()
                
                if args.create_scripts:
                    success &= self.create_startup_scripts()
                
                # 如果没有指定任何选项，执行基本设置
                if not any([args.create_dirs, args.setup_config, 
                           args.setup_ffmpeg, args.create_scripts]):
                    success &= self.create_directories()
                    success &= self.setup_config_file()
            
            print("\n" + "=" * 50)
            if success:
                print("✅ 环境配置完成")
                
                if args.setup_all:
                    print("\n🎉 VREconder 已准备就绪！")
                    print("\n使用方法:")
                    print("  python src/main.py --help")
                    print("  python tools/batch/batch_cli.py --help")
                    print("  或直接运行: ./start_vreconder.sh")
                
                return 0
            else:
                print("❌ 环境配置存在问题，请检查上述错误")
                return 1
                
        except KeyboardInterrupt:
            print("\n⚠️  用户中断操作")
            return 130
        except Exception as e:
            print(f"\n❌ 配置过程出错: {e}")
            if args.verbose:
                import traceback
                traceback.print_exc()
            return 1


def main():
    """入口点函数"""
    setup = EnvironmentSetup()
    sys.exit(setup.main())


if __name__ == "__main__":
    main() 