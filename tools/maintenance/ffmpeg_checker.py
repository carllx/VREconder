#!/usr/bin/env python3
"""
FFmpeg 环境检测工具
用户友好的 FFmpeg 安装和配置检测工具

基于 src/utils/ffmpeg_detector.py 提供更好的用户体验
"""
import sys
import argparse
import logging
from pathlib import Path
from typing import Dict, Any, Optional

# 添加src到路径
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from config.settings import Config
from utils.ffmpeg_detector import FFmpegDetector


class FFmpegChecker:
    """用户友好的 FFmpeg 检测工具"""
    
    def __init__(self, config_file: Optional[str] = None):
        """初始化检测器
        
        Args:
            config_file: 配置文件路径
        """
        self.config = Config(config_file)
        self.detector = FFmpegDetector(self.config)
        self.logger = logging.getLogger(__name__)
    
    def check_installation(self, verbose: bool = False) -> Dict[str, Any]:
        """检查 FFmpeg 安装状态
        
        Args:
            verbose: 是否详细输出
            
        Returns:
            检测结果字典
        """
        print("🔍 检测 FFmpeg 安装状态...")
        print("-" * 50)
        
        # 获取检测摘要
        summary = self.detector.get_detection_summary()
        
        # 显示系统信息
        print(f"操作系统: {summary['system'].title()}")
        
        # 显示 FFmpeg 检测结果
        if summary['ffmpeg_found']:
            print(f"✅ FFmpeg: 已找到")
            print(f"   路径: {summary['ffmpeg_path']}")
            
            if summary.get('version'):
                version_line = summary['version'].split('\n')[0] if '\n' in summary['version'] else summary['version']
                print(f"   版本: {version_line}")
            
            if summary.get('detection_method'):
                method_names = {
                    'config_file': '配置文件',
                    'system_path': '系统PATH',
                    'common_paths': '常见路径',
                    'package_manager': '包管理器',
                    'custom_paths': '自定义路径'
                }
                method = method_names.get(summary['detection_method'], summary['detection_method'])
                print(f"   检测方式: {method}")
        else:
            print("❌ FFmpeg: 未找到")
            
        # 显示 FFprobe 检测结果  
        if summary['ffprobe_found']:
            print(f"✅ FFprobe: 已找到")
            if verbose:
                print(f"   路径: {summary['ffprobe_path']}")
        else:
            print("❌ FFprobe: 未找到")
        
        # 显示错误信息
        if 'error' in summary:
            print(f"❌ 检测错误: {summary['error']}")
        
        print("-" * 50)
        
        # 显示建议
        if not summary['ffmpeg_found']:
            self._show_installation_instructions()
        elif verbose:
            self._show_additional_info(summary)
            
        return summary
    
    def _show_installation_instructions(self):
        """显示安装说明"""
        system = self.detector.system
        
        print("💡 FFmpeg 安装建议:")
        print()
        
        if system == "windows":
            print("Windows 安装方式:")
            print("1. 官方下载:")
            print("   - 访问: https://ffmpeg.org/download.html")
            print("   - 下载 Windows 构建版本")
            print("   - 解压到 C:\\ffmpeg\\")
            print("   - 将 C:\\ffmpeg\\bin\\ 添加到系统 PATH")
            print()
            print("2. 使用 Chocolatey:")
            print("   choco install ffmpeg")
            print()
            print("3. 使用 Scoop:")
            print("   scoop install ffmpeg")
            
        elif system == "darwin":
            print("macOS 安装方式:")
            print("1. 使用 Homebrew (推荐):")
            print("   brew install ffmpeg")
            print()
            print("2. 使用 MacPorts:")
            print("   sudo port install ffmpeg")
            print()
            print("3. 官方二进制:")
            print("   - 访问: https://ffmpeg.org/download.html")
            print("   - 下载 macOS 构建版本")
            
        else:  # Linux
            print("Linux 安装方式:")
            print("1. Ubuntu/Debian:")
            print("   sudo apt update && sudo apt install ffmpeg")
            print()
            print("2. CentOS/RHEL/Fedora:")
            print("   sudo dnf install ffmpeg")
            print("   # 或 sudo yum install ffmpeg")
            print()
            print("3. 使用 Snap:")
            print("   sudo snap install ffmpeg")
            print()
            print("4. 从源码编译:")
            print("   # 下载源码并按官方文档编译")
        
        print()
        print("配置说明:")
        print("- 安装后重启命令行/终端")
        print("- 或在 config/settings.yaml 中指定路径:")
        print("  paths:")
        print("    windows:")
        print("      ffmpeg_path: 'C:/ffmpeg/bin/ffmpeg.exe'")
        print("    macos:")
        print("      ffmpeg_path: '/usr/local/bin/ffmpeg'")
    
    def _show_additional_info(self, summary: Dict[str, Any]):
        """显示额外信息"""
        print("📋 详细信息:")
        
        if summary.get('ffmpeg_path'):
            ffmpeg_path = Path(summary['ffmpeg_path'])
            if ffmpeg_path.exists() and ffmpeg_path != Path('ffmpeg'):
                try:
                    size = ffmpeg_path.stat().st_size / (1024 * 1024)
                    print(f"   FFmpeg 文件大小: {size:.1f} MB")
                except:
                    pass
        
        # 显示配置文件状态
        config_path = self.detector._get_config_path()
        if config_path:
            print(f"   配置文件中的路径: {config_path}")
        else:
            print("   配置文件: 未配置 FFmpeg 路径")
    
    def test_functionality(self) -> bool:
        """测试 FFmpeg 功能"""
        print("\n🧪 测试 FFmpeg 功能...")
        print("-" * 50)
        
        try:
            is_working, version_info = self.detector.test_ffmpeg_installation()
            
            if is_working:
                print("✅ FFmpeg 功能测试: 通过")
                print(f"   版本信息: {version_info}")
                
                # 测试常用编码器
                self._test_encoders()
                
                return True
            else:
                print("❌ FFmpeg 功能测试: 失败")
                print(f"   错误信息: {version_info}")
                return False
                
        except Exception as e:
            print(f"❌ 测试过程出错: {e}")
            return False
    
    def _test_encoders(self):
        """测试编码器可用性"""
        print("\n🎬 检测编码器支持:")
        
        encoders_to_test = [
            ('libx265', 'x265 (软件编码)'),
            ('hevc_nvenc', 'NVENC (NVIDIA硬件编码)'),
            ('hevc_qsv', 'QuickSync (Intel硬件编码)'),
            ('hevc_amf', 'AMF (AMD硬件编码)')
        ]
        
        try:
            ffmpeg_path = self.detector.detect_ffmpeg_path()
            
            import subprocess
            # 获取编码器列表
            result = subprocess.run(
                [ffmpeg_path, '-encoders'], 
                capture_output=True, 
                text=True, 
                timeout=10
            )
            
            if result.returncode == 0:
                available_encoders = result.stdout
                
                for encoder_name, encoder_desc in encoders_to_test:
                    if encoder_name in available_encoders:
                        print(f"   ✅ {encoder_desc}")
                    else:
                        print(f"   ❌ {encoder_desc}")
            else:
                print("   ⚠️  无法获取编码器列表")
                
        except Exception as e:
            print(f"   ⚠️  编码器检测失败: {e}")
    
    def diagnose_issues(self) -> Dict[str, Any]:
        """诊断常见问题"""
        print("\n🔧 诊断常见问题...")
        print("-" * 50)
        
        issues = []
        suggestions = []
        
        # 检查路径权限
        try:
            ffmpeg_path = self.detector.detect_ffmpeg_path()
            path_obj = Path(ffmpeg_path)
            
            if path_obj != Path('ffmpeg') and path_obj.exists():
                if not path_obj.is_file():
                    issues.append("FFmpeg路径指向的不是文件")
                    suggestions.append("检查配置文件中的路径设置")
                
                # Windows下检查可执行权限
                if self.detector.is_windows:
                    if not path_obj.suffix.lower() == '.exe':
                        issues.append("Windows下FFmpeg应该是.exe文件")
                        suggestions.append("确保下载的是Windows版本的FFmpeg")
        
        except Exception as e:
            issues.append(f"路径检测失败: {e}")
            suggestions.append("检查FFmpeg是否正确安装")
        
        # 检查环境变量
        import os
        path_env = os.environ.get('PATH', '')
        if 'ffmpeg' not in path_env.lower():
            issues.append("系统PATH中可能不包含FFmpeg")
            suggestions.append("将FFmpeg添加到系统PATH环境变量")
        
        # 显示结果
        if not issues:
            print("✅ 未发现明显问题")
        else:
            print("⚠️  发现以下问题:")
            for i, issue in enumerate(issues, 1):
                print(f"   {i}. {issue}")
            
            print("\n💡 建议解决方案:")
            for i, suggestion in enumerate(suggestions, 1):
                print(f"   {i}. {suggestion}")
        
        return {
            'issues': issues,
            'suggestions': suggestions
        }
    
    def create_parser(self) -> argparse.ArgumentParser:
        """创建命令行参数解析器"""
        parser = argparse.ArgumentParser(
            description="FFmpeg 环境检测工具",
            formatter_class=argparse.RawDescriptionHelpFormatter,
            epilog="""
示例:
  # 基本检测
  python %(prog)s
  
  # 详细检测 + 功能测试
  python %(prog)s --test --verbose
  
  # 问题诊断
  python %(prog)s --diagnose
            """
        )
        
        parser.add_argument(
            '--test', 
            action='store_true',
            help='执行功能测试'
        )
        parser.add_argument(
            '--diagnose', 
            action='store_true',
            help='诊断常见问题'
        )
        parser.add_argument(
            '--verbose', '-v', 
            action='store_true',
            help='详细输出'
        )
        parser.add_argument(
            '--config-file', 
            type=Path,
            help='指定配置文件路径'
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
            print("🎬 VREconder FFmpeg 环境检测工具")
            print("=" * 50)
            
            # 创建检测器
            config_file = str(args.config_file) if args.config_file else None
            checker = FFmpegChecker(config_file)
            
            # 执行基本检测
            summary = checker.check_installation(args.verbose)
            
            # 执行功能测试
            if args.test and summary['ffmpeg_found']:
                test_result = checker.test_functionality()
                if not test_result:
                    return 1
            
            # 执行问题诊断
            if args.diagnose:
                checker.diagnose_issues()
            
            # 返回状态码
            if summary['ffmpeg_found']:
                print("\n✅ FFmpeg 环境检测完成")
                return 0
            else:
                print("\n❌ FFmpeg 未正确安装或配置")
                return 1
                
        except KeyboardInterrupt:
            print("\n⚠️  用户中断操作")
            return 130
        except Exception as e:
            print(f"\n❌ 检测过程出错: {e}")
            if args.verbose:
                import traceback
                traceback.print_exc()
            return 1


def main():
    """入口点函数"""
    checker = FFmpegChecker()
    sys.exit(checker.main())


if __name__ == "__main__":
    main() 