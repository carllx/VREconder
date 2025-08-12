#!/usr/bin/env python3
"""
VREconder - 统一跨平台CLI工具
整合批量处理、系统维护、环境配置等所有功能

用法:
    python vreconder.py batch --input-dir ./videos --output-dir ./output
    python vreconder.py maintenance ffmpeg-check
    python vreconder.py setup --install-deps
"""

import sys
import argparse
from pathlib import Path

# 确保项目路径
PROJECT_ROOT = Path(__file__).parent
sys.path.insert(0, str(PROJECT_ROOT))


def create_main_parser():
    """创建主命令解析器"""
    parser = argparse.ArgumentParser(
        prog='vreconder',
        description='VREconder - 专业VR视频处理工具',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
子命令:
  batch          批量视频处理
  maintenance    系统维护工具  
  setup          环境配置
  single         单文件处理
  dash-merge     DASH视频分段合并
  
示例:
  python vreconder.py batch --input-dir ./videos --output-dir ./output
  python vreconder.py maintenance ffmpeg-check
  python vreconder.py setup --check-env
  python vreconder.py dash-merge ./dash_folder --output ./merged.mp4
        """
    )
    
    subparsers = parser.add_subparsers(dest='command', help='可用命令')
    
    # 批量处理命令
    batch_parser = subparsers.add_parser('batch', help='批量视频处理')
    setup_batch_parser(batch_parser)
    
    # 维护命令
    maintenance_parser = subparsers.add_parser('maintenance', help='系统维护')
    setup_maintenance_parser(maintenance_parser)
    
    # 配置命令
    setup_parser = subparsers.add_parser('setup', help='环境配置')
    setup_setup_parser(setup_parser)
    
    # 单文件处理命令
    single_parser = subparsers.add_parser('single', help='单文件处理')
    setup_single_parser(single_parser)
    
    # DASH合并命令
    dash_parser = subparsers.add_parser('dash-merge', help='DASH视频分段合并')
    setup_dash_parser(dash_parser)
    
    return parser


def setup_batch_parser(parser):
    """设置批量处理子命令"""
    # 必需参数
    parser.add_argument('--input-dir', type=Path, required=True, help='输入目录')
    parser.add_argument('--output-dir', type=Path, required=True, help='输出目录')
    
    # 处理参数
    parser.add_argument('--encoder', choices=['libx265', 'hevc_nvenc', 'hevc_qsv'], 
                       default='libx265', help='编码器类型')
    parser.add_argument('--quality', choices=['low', 'medium', 'high', 'ultra'], 
                       default='high', help='质量预设')
    parser.add_argument('--max-workers', type=int, default=2, help='并发任务数')
    parser.add_argument('--parallel-files', type=int, default=1, help='并发文件数')
    
    # 可选参数
    parser.add_argument('--dry-run', action='store_true', help='模拟运行')
    parser.add_argument('--list-files', action='store_true', help='列出文件')
    parser.add_argument('--verbose', '-v', action='store_true', help='详细输出')


def setup_maintenance_parser(parser):
    """设置维护子命令"""
    maintenance_subparsers = parser.add_subparsers(dest='maintenance_action')
    
    # FFmpeg检查
    ffmpeg_parser = maintenance_subparsers.add_parser('ffmpeg-check', help='FFmpeg环境检测')
    ffmpeg_parser.add_argument('--test', action='store_true', help='运行测试')
    ffmpeg_parser.add_argument('--diagnose', action='store_true', help='诊断问题')
    
    # 系统诊断
    system_parser = maintenance_subparsers.add_parser('system-diagnose', help='系统诊断')
    system_parser.add_argument('--full', action='store_true', help='完整诊断')
    
    # 配置验证
    config_parser = maintenance_subparsers.add_parser('config-validate', help='配置验证')
    config_parser.add_argument('--create-sample', action='store_true', help='创建示例配置')


def setup_setup_parser(parser):
    """设置环境配置子命令"""
    parser.add_argument('--install-deps', action='store_true', help='安装Python依赖')
    parser.add_argument('--check-env', action='store_true', help='检查环境')
    parser.add_argument('--setup-all', action='store_true', help='完整环境配置')
    parser.add_argument('--create-dirs', action='store_true', help='创建目录结构')


def setup_single_parser(parser):
    """设置单文件处理子命令"""
    parser.add_argument('--input-file', type=Path, required=True, help='输入文件')
    parser.add_argument('--output-file', type=Path, required=True, help='输出文件')
    parser.add_argument('--encoder', choices=['libx265', 'hevc_nvenc', 'hevc_qsv'], 
                       default='libx265', help='编码器类型')
    parser.add_argument('--quality', choices=['low', 'medium', 'high', 'ultra'], 
                       default='high', help='质量预设')


def setup_dash_parser(parser):
    """设置DASH合并子命令"""
    parser.add_argument('path', type=Path, help='包含m4s文件的文件夹路径或父目录路径')
    parser.add_argument('--batch', action='store_true', help='批量处理所有子目录')
    parser.add_argument('--output', '-o', type=Path, help='输出文件路径 (单文件夹处理时)')
    parser.add_argument('--workers', '-w', type=int, default=4, help='并行处理任务数 (批量模式, 默认: 4)')
    parser.add_argument('--dry-run', action='store_true', help='模拟运行，预览操作')
    parser.add_argument('--verbose', '-v', action='store_true', help='详细输出')


def handle_batch_command(args):
    """处理批量处理命令"""
    try:
        from tools.batch.batch_cli import BatchCLI
        cli = BatchCLI()
        
        # 转换参数格式
        batch_args = [
            '--input-dir', str(args.input_dir),
            '--output-dir', str(args.output_dir),
            '--encoder', args.encoder,
            '--quality', args.quality,
            '--max-workers', str(args.max_workers),
            '--parallel-files', str(args.parallel_files)
        ]
        
        if args.dry_run:
            batch_args.append('--dry-run')
        if args.list_files:
            batch_args.append('--list-files')
        if args.verbose:
            batch_args.append('--verbose')
        
        return cli.main(batch_args)
        
    except ImportError as e:
        print(f"❌ 批量处理模块导入失败: {e}")
        print("请确保项目结构完整")
        return 1


def handle_maintenance_command(args):
    """处理维护命令"""
    if args.maintenance_action == 'ffmpeg-check':
        try:
            from tools.maintenance.ffmpeg_checker import main as ffmpeg_main
            sys.argv = ['ffmpeg_checker.py']
            if args.test:
                sys.argv.append('--test')
            if args.diagnose:
                sys.argv.append('--diagnose')
            return ffmpeg_main()
        except ImportError:
            print("❌ FFmpeg检查工具不可用")
            return 1
    
    elif args.maintenance_action == 'system-diagnose':
        try:
            from tools.maintenance.system_diagnose import main as system_main
            sys.argv = ['system_diagnose.py']
            if args.full:
                sys.argv.append('--full')
            return system_main()
        except ImportError:
            print("❌ 系统诊断工具不可用")
            return 1
    
    elif args.maintenance_action == 'config-validate':
        try:
            from tools.maintenance.config_validator import main as config_main
            sys.argv = ['config_validator.py']
            if args.create_sample:
                sys.argv.append('--create-sample')
            return config_main()
        except ImportError:
            print("❌ 配置验证工具不可用")
            return 1
    
    else:
        print("❌ 未知的维护命令")
        return 1


def handle_setup_command(args):
    """处理环境配置命令"""
    try:
        if args.install_deps:
            from tools.deployment.install_deps import main as install_main
            return install_main(['--install'])
        
        elif args.check_env:
            from tools.deployment.setup_env import main as setup_main
            return setup_main(['--check-only'])
        
        elif args.setup_all:
            from tools.deployment.setup_env import main as setup_main
            return setup_main(['--setup-all'])
        
        elif args.create_dirs:
            from tools.deployment.setup_env import main as setup_main
            return setup_main(['--create-dirs'])
        
        else:
            print("请指定配置操作：--install-deps, --check-env, --setup-all, --create-dirs")
            return 1
            
    except ImportError as e:
        print(f"❌ 配置工具导入失败: {e}")
        return 1


def handle_single_command(args):
    """处理单文件处理命令"""
    try:
        from src.main import main as src_main
        sys.argv = [
            'main.py', 'split-encode-merge',
            '--input-file', str(args.input_file),
            '--output-file', str(args.output_file),
            '--encoder', args.encoder,
            '--quality', args.quality
        ]
        return src_main()
        
    except ImportError as e:
        print(f"❌ 核心模块导入失败: {e}")
        return 1


def handle_dash_command(args):
    """处理DASH合并命令"""
    try:
        if args.batch:
            # 使用高效的批量处理器
            from tools.batch_dash_merge import BatchDashMerger
            
            # 设置输出目录
            output_dir = args.output or (args.path / "merged")
            
            print(f"🎬 VREconder 批量DASH合并")
            print(f"📁 输入目录: {args.path}")
            print(f"📁 输出目录: {output_dir}")
            print(f"🔧 并行任务: {args.workers}")
            
            # 创建批量处理器
            batch_merger = BatchDashMerger(max_workers=args.workers, verbose=args.verbose)
            
            # 执行批量处理
            results = batch_merger.process_batch(args.path, output_dir, dry_run=args.dry_run)
            
            if results and not args.dry_run:
                # 生成报告
                report_file = batch_merger.generate_report(output_dir)
                # 显示摘要
                batch_merger.display_final_summary(report_file)
            
            # 返回适当的退出代码
            if not results:
                return 0 if args.dry_run else 1
            
            failed_count = sum(1 for r in results if not r.success)
            return 0 if failed_count == 0 else 1
            
        else:
            # 单文件夹处理
            from src.combiners.dash_merger import DashMerger
            
            merger = DashMerger(verbose=args.verbose)
            
            # 检查依赖
            if not merger.check_dependencies():
                print("❌ FFmpeg未找到，请安装FFmpeg")
                return 1
            
            try:
                print(f"🔄 处理单个文件夹: {args.path}")
                success = merger.merge_single_folder(args.path, args.output, dry_run=args.dry_run)
                
                if success and not args.dry_run:
                    print("✅ DASH合并完成")
                elif not success:
                    print("❌ DASH合并失败")
                
                return 0 if success else 1
                
            finally:
                merger.cleanup()
            
    except ImportError as e:
        print(f"❌ DASH合并模块导入失败: {e}")
        print("请确保项目结构完整")
        return 1
    except Exception as e:
        print(f"❌ DASH合并出错: {e}")
        return 1


def main():
    """主入口点"""
    parser = create_main_parser()
    
    # 如果没有参数，显示帮助
    if len(sys.argv) == 1:
        parser.print_help()
        return 0
    
    args = parser.parse_args()
    
    # 根据命令分发处理
    if args.command == 'batch':
        return handle_batch_command(args)
    
    elif args.command == 'maintenance':
        return handle_maintenance_command(args)
    
    elif args.command == 'setup':
        return handle_setup_command(args)
    
    elif args.command == 'single':
        return handle_single_command(args)
    
    elif args.command == 'dash-merge':
        return handle_dash_command(args)
    
    else:
        parser.print_help()
        return 1


if __name__ == '__main__':
    sys.exit(main()) 