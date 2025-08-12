#!/usr/bin/env python3
"""
批量处理命令行接口
提供用户友好的命令行工具来批量处理VR视频

用法示例:
    python tools/batch/batch_cli.py --input-dir videos/ --output-dir output/
    python tools/batch/batch_cli.py --input-dir videos/ --output-dir output/ --encoder hevc_nvenc --quality high
"""
import sys
import argparse
import logging
from pathlib import Path
from typing import Optional

# 动态导入batch_processor
import sys
from pathlib import Path

# 添加tools到路径
tools_path = str(Path(__file__).parent.parent)
if tools_path not in sys.path:
    sys.path.insert(0, tools_path)

try:
    from batch.batch_processor import BatchProcessor
except ImportError:
    # 如果模块导入方式不工作，直接导入文件
    import importlib.util
    spec = importlib.util.spec_from_file_location("batch_processor", 
                                                 Path(__file__).parent / "batch_processor.py")
    batch_processor_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(batch_processor_module)
    BatchProcessor = batch_processor_module.BatchProcessor


class BatchCLI:
    """批量处理命令行接口"""
    
    def __init__(self):
        self.processor = None
        self.logger = None
    
    def setup_logging(self, verbose: bool = False):
        """设置日志"""
        level = logging.DEBUG if verbose else logging.INFO
        logging.basicConfig(
            level=level,
            format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        self.logger = logging.getLogger(__name__)
    
    def create_parser(self) -> argparse.ArgumentParser:
        """创建命令行参数解析器"""
        parser = argparse.ArgumentParser(
            description="VREconder 批量视频处理工具",
            formatter_class=argparse.RawDescriptionHelpFormatter,
            epilog="""
示例:
  # 基本批量处理
  python %(prog)s --input-dir ./videos --output-dir ./output

  # 使用NVENC编码器和高质量
  python %(prog)s --input-dir ./videos --output-dir ./output --encoder hevc_nvenc --quality high

  # 并行处理2个文件，每个文件使用4个工作线程
  python %(prog)s --input-dir ./videos --output-dir ./output --parallel-files 2 --max-workers 4

  # 强制4K限制和跳过分割编码
  python %(prog)s --input-dir ./videos --output-dir ./output --force-4k --skip-split-encode

支持的编码器: libx265, hevc_nvenc, hevc_qsv
支持的质量: low, medium, high, ultra
            """
        )
        
        # 必需参数
        parser.add_argument(
            '--input-dir', 
            type=Path, 
            required=True,
            help='输入目录 (包含待处理的视频文件)'
        )
        parser.add_argument(
            '--output-dir', 
            type=Path, 
            required=True,
            help='输出目录 (处理后的视频文件保存位置)'
        )
        
        # 处理参数
        parser.add_argument(
            '--segment-duration', 
            type=float, 
            default=300.0,
            help='视频分割时长，单位秒 (默认: 300)'
        )
        parser.add_argument(
            '--encoder', 
            choices=['libx265', 'hevc_nvenc', 'hevc_qsv'], 
            default='libx265',
            help='HEVC编码器类型 (默认: libx265)'
        )
        parser.add_argument(
            '--quality', 
            choices=['low', 'medium', 'high', 'ultra'], 
            default='high',
            help='编码质量预设 (默认: high)'
        )
        parser.add_argument(
            '--max-workers', 
            type=int, 
            default=2,
            help='每个文件的并发编码任务数 (默认: 2)'
        )
        parser.add_argument(
            '--parallel-files', 
            type=int, 
            default=1,
            help='同时处理的文件数量 (默认: 1)'
        )
        
        # 可选参数
        parser.add_argument(
            '--temp-dir', 
            type=Path,
            help='临时目录路径 (用于断点续传)'
        )
        parser.add_argument(
            '--skip-split-encode', 
            action='store_true',
            help='跳过分割阶段的编码，直接使用copy模式分割'
        )
        parser.add_argument(
            '--force-4k', 
            action='store_true',
            help='强制将4K以上视频压缩为4K以内'
        )
        parser.add_argument(
            '--config-file', 
            type=Path,
            help='配置文件路径 (默认使用 config/settings.yaml)'
        )
        
        # 工具参数
        parser.add_argument(
            '--verbose', '-v', 
            action='store_true',
            help='详细输出模式'
        )
        parser.add_argument(
            '--dry-run', 
            action='store_true',
            help='模拟运行，仅显示将要处理的文件列表'
        )
        parser.add_argument(
            '--list-files', 
            action='store_true',
            help='列出输入目录中的所有视频文件'
        )
        
        return parser
    
    def validate_args(self, args) -> bool:
        """验证命令行参数"""
        # 检查输入目录
        if not args.input_dir.exists():
            self.logger.error(f"输入目录不存在: {args.input_dir}")
            return False
        
        if not args.input_dir.is_dir():
            self.logger.error(f"输入路径不是目录: {args.input_dir}")
            return False
        
        # 检查输出目录
        if args.output_dir.exists() and not args.output_dir.is_dir():
            self.logger.error(f"输出路径存在但不是目录: {args.output_dir}")
            return False
        
        # 检查参数范围
        if args.parallel_files < 1 or args.parallel_files > 4:
            self.logger.error(f"parallel_files 必须在1-4之间: {args.parallel_files}")
            return False
        
        if args.max_workers < 1 or args.max_workers > 8:
            self.logger.error(f"max_workers 必须在1-8之间: {args.max_workers}")
            return False
        
        if args.segment_duration <= 0:
            self.logger.error(f"segment_duration 必须大于0: {args.segment_duration}")
            return False
        
        return True
    
    def list_files_only(self, args):
        """仅列出文件，不处理"""
        self.logger.info(f"扫描目录: {args.input_dir}")
        
        try:
            processor = BatchProcessor(str(args.config_file) if args.config_file else None)
            video_files = processor.find_video_files(args.input_dir)
            
            if not video_files:
                print(f"在 {args.input_dir} 中未找到支持的视频文件")
                return
            
            print(f"\n找到 {len(video_files)} 个视频文件:")
            print("-" * 60)
            
            total_size = 0
            for i, video_file in enumerate(video_files, 1):
                size_mb = video_file.stat().st_size / (1024 * 1024)
                total_size += size_mb
                print(f"{i:3d}. {video_file.name} ({size_mb:.2f} MB)")
            
            print("-" * 60)
            print(f"总计: {len(video_files)} 个文件, {total_size:.2f} MB")
            
        except Exception as e:
            self.logger.error(f"扫描文件时出错: {e}")
    
    def dry_run(self, args):
        """模拟运行"""
        self.logger.info("=== 模拟运行模式 ===")
        
        try:
            processor = BatchProcessor(str(args.config_file) if args.config_file else None)
            
            # 验证参数
            process_params = {
                'encoder': args.encoder,
                'quality': args.quality,
                'max_workers': args.max_workers,
                'segment_duration': args.segment_duration
            }
            
            valid, message = processor.validate_parameters(**process_params)
            if not valid:
                self.logger.error(f"参数验证失败: {message}")
                return False
            
            # 扫描文件
            video_files = processor.find_video_files(args.input_dir)
            if not video_files:
                print(f"在 {args.input_dir} 中未找到支持的视频文件")
                return False
            
            print(f"\n将要处理的配置:")
            print(f"  输入目录: {args.input_dir}")
            print(f"  输出目录: {args.output_dir}")
            print(f"  编码器: {args.encoder}")
            print(f"  质量: {args.quality}")
            print(f"  并发文件数: {args.parallel_files}")
            print(f"  每文件工作线程: {args.max_workers}")
            print(f"  分割时长: {args.segment_duration} 秒")
            print(f"  跳过分割编码: {args.skip_split_encode}")
            print(f"  强制4K: {args.force_4k}")
            
            print(f"\n将要处理的文件 ({len(video_files)} 个):")
            print("-" * 60)
            
            for i, video_file in enumerate(video_files, 1):
                output_file = args.output_dir / f"{video_file.stem}_final_{args.encoder}.mp4"
                size_mb = video_file.stat().st_size / (1024 * 1024)
                print(f"{i:3d}. {video_file.name} ({size_mb:.2f} MB)")
                print(f"     -> {output_file.name}")
            
            print("-" * 60)
            print("注意: 这是模拟运行，实际文件未被处理")
            
            return True
            
        except Exception as e:
            self.logger.error(f"模拟运行时出错: {e}")
            return False
    
    def run_batch_process(self, args):
        """执行实际的批量处理"""
        try:
            # 创建批量处理器
            processor = BatchProcessor(str(args.config_file) if args.config_file else None)
            
            # 准备处理参数
            process_options = {
                'segment_duration': args.segment_duration,
                'encoder': args.encoder,
                'quality': args.quality,
                'max_workers': args.max_workers,
                'skip_split_encode': args.skip_split_encode,
                'force_4k': args.force_4k,
                'temp_dir': args.temp_dir
            }
            
            # 验证参数
            valid, message = processor.validate_parameters(**process_options)
            if not valid:
                self.logger.error(f"参数验证失败: {message}")
                return False
            
            print("=== 开始批量处理 ===")
            print(f"输入目录: {args.input_dir}")
            print(f"输出目录: {args.output_dir}")
            print(f"处理配置: {args.encoder} ({args.quality} 质量)")
            print("-" * 60)
            
            # 执行批量处理
            results = processor.process_directory(
                input_dir=args.input_dir,
                output_dir=args.output_dir,
                parallel_files=args.parallel_files,
                **process_options
            )
            
            # 显示结果
            print("\n" + "=" * 60)
            print("批量处理完成")
            print(f"成功: {results['processed']} 个文件")
            print(f"失败: {results['failed']} 个文件")
            print(f"总用时: {results['total_time']:.1f} 秒")
            
            if results['failed'] > 0:
                print("\n失败的文件:")
                for result in results['results']:
                    if not result['success']:
                        print(f"  - {result['file']}: {result['message']}")
            
            return results['success']
            
        except Exception as e:
            self.logger.error(f"批量处理时出错: {e}")
            return False
    
    def main(self, argv=None):
        """主函数"""
        parser = self.create_parser()
        args = parser.parse_args(argv)
        
        # 设置日志
        self.setup_logging(args.verbose)
        
        # 验证参数
        if not self.validate_args(args):
            return 1
        
        try:
            # 根据参数选择操作模式
            if args.list_files:
                self.list_files_only(args)
                return 0
            elif args.dry_run:
                success = self.dry_run(args)
                return 0 if success else 1
            else:
                success = self.run_batch_process(args)
                return 0 if success else 1
                
        except KeyboardInterrupt:
            self.logger.info("用户中断操作")
            return 130
        except Exception as e:
            self.logger.error(f"程序异常: {e}")
            if args.verbose:
                import traceback
                traceback.print_exc()
            return 1


def main():
    """入口点函数"""
    cli = BatchCLI()
    sys.exit(cli.main())


if __name__ == "__main__":
    main() 