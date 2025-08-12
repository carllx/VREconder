#!/usr/bin/env python3
"""
依赖安装工具
自动安装和检查VREconder项目的依赖
"""
import sys
import subprocess
import argparse
import logging
from pathlib import Path
from typing import List, Dict, Tuple, Optional


class DependencyInstaller:
    """依赖安装工具"""
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.project_root = Path(__file__).parent.parent.parent
    
    def check_python_version(self) -> Tuple[bool, str]:
        """检查Python版本"""
        print("🐍 检查Python版本...")
        
        version = sys.version_info
        version_str = f"{version.major}.{version.minor}.{version.micro}"
        
        if version >= (3, 8):
            print(f"   ✅ Python {version_str} (满足要求)")
            return True, version_str
        else:
            print(f"   ❌ Python {version_str} (需要3.8+)")
            return False, version_str
    
    def install_pip_dependencies(self, requirements_file: Optional[Path] = None) -> bool:
        """安装pip依赖"""
        if requirements_file is None:
            requirements_file = self.project_root / "requirements.txt"
        
        print(f"📦 安装Python依赖: {requirements_file}")
        
        if not requirements_file.exists():
            print(f"   ⚠️  requirements.txt不存在: {requirements_file}")
            return self._install_basic_dependencies()
        
        try:
            cmd = [sys.executable, '-m', 'pip', 'install', '-r', str(requirements_file)]
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            print("   ✅ 依赖安装成功")
            return True
        except subprocess.CalledProcessError as e:
            print(f"   ❌ 依赖安装失败: {e.stderr}")
            return False
    
    def _install_basic_dependencies(self) -> bool:
        """安装基本依赖"""
        basic_deps = [
            'pyyaml',
            'psutil',
            'pathlib',
        ]
        
        print("   安装基本依赖...")
        success = True
        
        for dep in basic_deps:
            try:
                cmd = [sys.executable, '-m', 'pip', 'install', dep]
                result = subprocess.run(cmd, capture_output=True, text=True, check=True)
                print(f"   ✅ {dep}")
            except subprocess.CalledProcessError as e:
                print(f"   ❌ {dep}: {e.stderr}")
                success = False
        
        return success
    
    def check_dependencies(self) -> Dict[str, bool]:
        """检查依赖状态"""
        print("\n🔍 检查依赖状态...")
        
        dependencies = {
            'yaml': False,
            'psutil': False,
            'pathlib': False,
        }
        
        for dep_name in dependencies:
            try:
                __import__(dep_name)
                dependencies[dep_name] = True
                print(f"   ✅ {dep_name}")
            except ImportError:
                print(f"   ❌ {dep_name} (未安装)")
        
        return dependencies
    
    def create_requirements_file(self) -> bool:
        """创建requirements.txt文件"""
        requirements_path = self.project_root / "requirements.txt"
        
        print(f"📝 创建requirements.txt: {requirements_path}")
        
        requirements_content = """# VREconder 项目依赖
# 核心依赖
PyYAML>=6.0
psutil>=5.8.0

# 可选依赖（用于扩展功能）
numpy>=1.21.0
opencv-python>=4.5.0
Pillow>=8.0.0

# 开发依赖（可选）
pytest>=6.0.0
pytest-cov>=2.10.0
flake8>=3.8.0
"""
        
        try:
            with open(requirements_path, 'w', encoding='utf-8') as f:
                f.write(requirements_content)
            print("   ✅ requirements.txt创建成功")
            return True
        except Exception as e:
            print(f"   ❌ 创建失败: {e}")
            return False
    
    def setup_development_environment(self) -> bool:
        """设置开发环境"""
        print("\n🛠️  设置开发环境...")
        
        # 安装开发依赖
        dev_deps = [
            'pytest',
            'pytest-cov', 
            'flake8',
            'black',
            'isort'
        ]
        
        success = True
        for dep in dev_deps:
            try:
                cmd = [sys.executable, '-m', 'pip', 'install', dep]
                result = subprocess.run(cmd, capture_output=True, text=True, check=True)
                print(f"   ✅ {dep}")
            except subprocess.CalledProcessError as e:
                print(f"   ❌ {dep}: 安装失败")
                success = False
        
        return success
    
    def create_parser(self) -> argparse.ArgumentParser:
        """创建命令行参数解析器"""
        parser = argparse.ArgumentParser(
            description="VREconder 依赖安装工具",
            formatter_class=argparse.RawDescriptionHelpFormatter,
            epilog="""
示例:
  # 检查依赖状态
  python %(prog)s --check-only
  
  # 安装所有依赖
  python %(prog)s --install
  
  # 创建requirements.txt
  python %(prog)s --create-requirements
  
  # 设置开发环境
  python %(prog)s --dev-env
            """
        )
        
        parser.add_argument(
            '--check-only', 
            action='store_true',
            help='仅检查依赖状态，不安装'
        )
        parser.add_argument(
            '--install', 
            action='store_true',
            help='安装依赖'
        )
        parser.add_argument(
            '--create-requirements', 
            action='store_true',
            help='创建requirements.txt文件'
        )
        parser.add_argument(
            '--dev-env', 
            action='store_true',
            help='设置开发环境'
        )
        parser.add_argument(
            '--requirements-file', 
            type=Path,
            help='指定requirements.txt文件路径'
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
            print("📦 VREconder 依赖安装工具")
            print("=" * 50)
            
            # 检查Python版本
            python_ok, python_version = self.check_python_version()
            if not python_ok:
                print("\n❌ Python版本不满足要求，请升级到Python 3.8+")
                return 1
            
            if args.create_requirements:
                success = self.create_requirements_file()
                return 0 if success else 1
            
            if args.check_only:
                deps_status = self.check_dependencies()
                missing_deps = [name for name, installed in deps_status.items() if not installed]
                
                if missing_deps:
                    print(f"\n⚠️  缺少依赖: {', '.join(missing_deps)}")
                    print("运行 --install 来安装缺少的依赖")
                    return 1
                else:
                    print("\n✅ 所有依赖都已安装")
                    return 0
            
            if args.install:
                print()
                success = self.install_pip_dependencies(args.requirements_file)
                if success:
                    print("\n✅ 依赖安装完成")
                    
                    # 验证安装
                    deps_status = self.check_dependencies()
                    missing_deps = [name for name, installed in deps_status.items() if not installed]
                    
                    if missing_deps:
                        print(f"⚠️  仍有依赖缺失: {', '.join(missing_deps)}")
                        return 1
                    
                    return 0
                else:
                    print("\n❌ 依赖安装失败")
                    return 1
            
            if args.dev_env:
                print()
                success = self.setup_development_environment()
                if success:
                    print("\n✅ 开发环境设置完成")
                    return 0
                else:
                    print("\n❌ 开发环境设置失败")
                    return 1
            
            # 默认：检查依赖状态
            deps_status = self.check_dependencies()
            missing_deps = [name for name, installed in deps_status.items() if not installed]
            
            if missing_deps:
                print(f"\n⚠️  缺少依赖: {', '.join(missing_deps)}")
                print("运行 --install 来安装缺少的依赖")
                return 1
            else:
                print("\n✅ 所有依赖都已安装")
                return 0
                
        except KeyboardInterrupt:
            print("\n⚠️  用户中断操作")
            return 130
        except Exception as e:
            print(f"\n❌ 安装过程出错: {e}")
            if args.verbose:
                import traceback
                traceback.print_exc()
            return 1


def main():
    """入口点函数"""
    installer = DependencyInstaller()
    sys.exit(installer.main())


if __name__ == "__main__":
    main() 