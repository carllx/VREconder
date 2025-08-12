#!/usr/bin/env python3
"""
VR Video Processing Pipeline - Main Entry Point (Refactored)
"""
import sys
import argparse
import logging
from pathlib import Path
from config.settings import Config
from processors.video_splitter import VideoSplitter
from encoders.hevc_encoder import HEVCEncoder, EncoderType, QualityPreset
from utils.progress_monitor import tail_ffmpeg_log
from utils.network_share import NetworkShareCLI
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading
from utils.progress_monitor import ProgressLogger

def split_encode_merge(config, input_file, output_file, segment_duration, encoder_type, quality_preset, max_workers, temp_dir, skip_split_encode=False, force_4k=False):
    logger = logging.getLogger(__name__)
    splitter = VideoSplitter(config)
    encoder = HEVCEncoder(config)
    # 统一中间目录
    safe_stem = input_file.stem.replace(' ', '_').replace('.', '_')
    base_dir = Path(temp_dir) if temp_dir else Path(config.get_path('paths.temp', './temp')) / f"split_encode_merge_{safe_stem}"
    splits_dir = base_dir / "splits"
    encoded_dir = base_dir / "encoded"
    splits_dir.mkdir(parents=True, exist_ok=True)
    encoded_dir.mkdir(parents=True, exist_ok=True)
    # 1. 分割
    segments = splitter.split_video(
        video_path=input_file,
        segment_duration=segment_duration,
        quality="high",
        parallel=False,  # 分割阶段串行，避免IO冲突
        encoder_type=encoder_type.value if hasattr(encoder_type, 'value') else encoder_type,
        crf=23,
        max_workers=1,  # 分割阶段固定为1个worker，避免IO冲突
        base_dir=splits_dir,
        skip_encode=True  # 修复：分割阶段只分割，不编码，避免重复编码
    )
    if not segments:
        logger.error("分割失败，无片段生成")
        return False
    # 2. 编码（智能跳过已编码文件）
    # 使用传入的 max_workers 参数，但确保至少为1
    encoding_workers = max(1, max_workers)
    logger.info(f"并行编码 {len(segments)} 个片段... (max_workers={encoding_workers})")
    logger.info(f"并行编码 {len(segments)} 个片段... (max_workers={max_workers})")
    logger.info(f"编码器类型: {encoder_type}")
    logger.info(f"质量预设: {quality_preset}")
    logger.info(f"编码目录: {encoded_dir}")
    
    # 验证编码器初始化
    try:
        logger.info(f"编码器FFmpeg路径: {encoder.ffmpeg_path}")
        logger.info(f"编码器可用编码器: {[e.value for e in encoder.available_encoders]}")
        
        # 测试编码器是否真的可用
        test_encoder_available = False
        for available_encoder in encoder.available_encoders:
            if available_encoder == encoder_type:
                test_encoder_available = True
                break
        
        if not test_encoder_available:
            logger.error(f"指定的编码器 {encoder_type} 不可用！")
            logger.error(f"可用编码器: {[e.value for e in encoder.available_encoders]}")
            return False
        else:
            logger.info(f"✓ 编码器 {encoder_type} 可用")
            
    except Exception as e:
        logger.error(f"编码器初始化检查失败: {e}")
        import traceback
        logger.error(f"异常详情: {traceback.format_exc()}")
        return False
    
    # 检查已存在的编码文件
    existing_encoded_files = []
    segments_to_encode = []
    
    logger.info("开始检查已存在的编码文件...")
    for seg in segments:
        encoded_file = encoded_dir / f"{seg.output_file.stem}_hevc.mp4"
        logger.info(f"检查编码文件: {encoded_file}")
        if encoded_file.exists() and encoded_file.stat().st_size > 0:
            existing_encoded_files.append(str(encoded_file))
            logger.info(f"跳过已编码文件: {encoded_file.name} (大小: {encoded_file.stat().st_size / (1024*1024):.2f} MB)")
        else:
            segments_to_encode.append(seg)
            logger.info(f"需要编码片段: {seg.output_file.name}")
    
    logger.info(f"已存在编码文件: {len(existing_encoded_files)} 个")
    logger.info(f"需要编码片段: {len(segments_to_encode)} 个")
    
    if not segments_to_encode:
        logger.info("所有片段都已编码完成，跳过编码阶段")
        encoded_files = existing_encoded_files
    else:
        logger.info(f"开始编码 {len(segments_to_encode)} 个片段")
        encoded_files = existing_encoded_files.copy()
        
        with ThreadPoolExecutor(max_workers=encoding_workers) as executor:
            future_to_seg = {}
            for seg in segments_to_encode:
                logger.info(f"提交编码任务: segment_{seg.segment_index} -> {seg.output_file.name}")
                encode_log_path = encoded_dir / f"{seg.output_file.stem}_hevc.log"
                progress_logger = ProgressLogger(str(encode_log_path), f"segment_{seg.segment_index}")
                
                # 验证输入文件存在
                if not seg.output_file.exists():
                    logger.error(f"输入文件不存在: {seg.output_file}")
                    continue
                
                logger.info(f"输入文件存在，大小: {seg.output_file.stat().st_size / (1024*1024):.2f} MB")
                    
                # 提交编码任务
                future = executor.submit(
                    encoder.encode_video,
                    seg.output_file,
                    encoded_dir / f"{seg.output_file.stem}_hevc.mp4",
                    encoder_type,
                    quality_preset,
                    None,  # crf 参数
                    "4k",  # resolution 参数
                    progress_logger,  # 传递日志对象，确保进度写入
                    force_4k  # 新增参数：强制4K限制
                )
                future_to_seg[future] = seg
                logger.info(f"已提交编码任务: segment_{seg.segment_index}")
            
            logger.info(f"等待 {len(future_to_seg)} 个编码任务完成...")
            
            for future in as_completed(future_to_seg):
                seg = future_to_seg[future]
                logger.info(f"[segment_{seg.segment_index}] 编码任务完成: {seg.output_file.name}")
                try:
                    result = future.result()
                    logger.info(f"[segment_{seg.segment_index}] 编码结果: {result}")
                    if result:
                        encoded_file = encoded_dir / f"{seg.output_file.stem}_hevc.mp4"
                        if encoded_file.exists():
                            encoded_files.append(str(encoded_file))
                            logger.info(f"[segment_{seg.segment_index}] 编码成功: {encoded_file} (大小: {encoded_file.stat().st_size / (1024*1024):.2f} MB)")
                        else:
                            logger.error(f"[segment_{seg.segment_index}] 编码文件不存在: {encoded_file}")
                    else:
                        logger.error(f"[segment_{seg.segment_index}] 片段编码失败: {seg.output_file}")
                except Exception as e:
                    logger.error(f"[segment_{seg.segment_index}] 片段编码异常: {seg.output_file}: {e}")
                    import traceback
                    logger.error(f"异常详情: {traceback.format_exc()}")
    
    logger.info(f"编码阶段完成，成功编码 {len(encoded_files)} 个文件")
    # 3. 合并
    logger.info(f"合并前将在此目录查找segments: {encoded_dir}")
    missing_files = [f for f in encoded_files if not Path(f).exists() or Path(f).stat().st_size == 0]
    if not encoded_files or missing_files:
        logger.error(f"合并失败，以下分段文件缺失或为空: {missing_files if missing_files else encoded_files}")
        return False
    logger.info(f"合并 {len(encoded_files)} 个编码片段...")
    concat_list = encoded_dir / "concat_list.txt"
    with open(concat_list, 'w', encoding='utf-8') as f:
        for ef in encoded_files:
            f.write(f"file '{ef.replace('\\', '/').replace("'", "'\\''")}'\n")
    merge_cmd = [
        'ffmpeg', '-y', '-f', 'concat', '-safe', '0',
        '-i', str(concat_list), '-c', 'copy', str(output_file)
    ]
    import subprocess
    result = subprocess.run(merge_cmd, capture_output=True, text=True)
    if result.returncode != 0:
        logger.error(f"合并失败: {result.stderr}")
        return False
    if not output_file.exists() or output_file.stat().st_size == 0:
        logger.error("合并失败: 输出文件为空或未生成")
        return False
    logger.info(f"合并完成: {output_file}")
    return True

def main():
    parser = argparse.ArgumentParser(description="VR Video Processing Pipeline (Refactored)")
    subparsers = parser.add_subparsers(dest='command', help='Available commands')
    
    # 视频处理命令
    split_encode_merge_parser = subparsers.add_parser('split-encode-merge', help='分割-并行编码-合并自动流程')
    split_encode_merge_parser.add_argument('--input-file', type=Path, required=True, help='输入视频文件')
    split_encode_merge_parser.add_argument('--output-file', type=Path, required=True, help='输出合并后文件')
    split_encode_merge_parser.add_argument('--segment-duration', type=float, default=300.0, help='分割时长(秒)')
    split_encode_merge_parser.add_argument('--encoder', choices=['libx265', 'hevc_nvenc', 'hevc_qsv'], default='hevc_nvenc', help='编码器类型')
    split_encode_merge_parser.add_argument('--quality', choices=['low', 'medium', 'high', 'ultra'], default='high', help='质量预设')
    split_encode_merge_parser.add_argument('--max-workers', type=int, default=2, help='并发编码任务数（默认2）')
    split_encode_merge_parser.add_argument('--temp-dir', type=Path, help='临时目录（用于断点续转）')
    split_encode_merge_parser.add_argument('--skip-split-encode', action='store_true', help='跳过分割阶段的编码，直接使用copy模式分割')
    split_encode_merge_parser.add_argument('--force-4k', action='store_true', help='强制4K以上视频压缩为4K以内')
    
    # 网络共享命令
    network_parser = subparsers.add_parser('network', help='网络共享管理')
    network_subparsers = network_parser.add_subparsers(dest='network_command', help='Network commands')
    
    setup_parser = network_subparsers.add_parser('setup', help='设置网络共享')
    setup_parser.add_argument('--share-path', type=Path, help='共享路径（默认项目根目录）')
    
    info_parser = network_subparsers.add_parser('info', help='显示共享信息')
    
    diagnose_parser = network_subparsers.add_parser('diagnose', help='网络诊断')
    
    create_script_parser = network_subparsers.add_parser('create-script', help='创建访问脚本')
    create_script_parser.add_argument('--output-path', type=Path, help='输出路径（默认项目根目录）')
    
    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return
    
    logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(name)s: %(message)s')
    config = Config()
    
    if args.command == 'split-encode-merge':
        encoder_type = EncoderType(args.encoder)
        quality_map = {
            'low': QualityPreset.FAST,
            'medium': QualityPreset.MEDIUM,
            'high': QualityPreset.SLOW,
            'ultra': QualityPreset.VERY_SLOW
        }
        quality = quality_map.get(args.quality, QualityPreset.SLOW)
        result = split_encode_merge(
            config=config,
            input_file=args.input_file,
            output_file=args.output_file,
            segment_duration=args.segment_duration,
            encoder_type=encoder_type,
            quality_preset=quality,
            max_workers=args.max_workers,
            temp_dir=args.temp_dir,
            skip_split_encode=args.skip_split_encode,
            force_4k=args.force_4k
        )
        if not result:
            print(f"\n[ERROR] 未生成最终输出文件: {args.output_file}，请检查编码日志。")
        else:
            print(f"\n[SUCCESS] 最终输出文件: {args.output_file}")
    
    elif args.command == 'network':
        network_cli = NetworkShareCLI(config)
        
        if args.network_command == 'setup':
            success = network_cli.setup(args.share_path)
            if success:
                print("\n[SUCCESS] 网络共享设置完成")
                network_cli.info()
                if config.get('network.access_script_auto_create', True):
                    network_cli.create_access_script()
            else:
                print("\n[ERROR] 网络共享设置失败")
        
        elif args.network_command == 'info':
            network_cli.info()
        
        elif args.network_command == 'diagnose':
            network_cli.diagnose()
        
        elif args.network_command == 'create-script':
            success = network_cli.create_access_script(args.output_path)
            if success:
                print("\n[SUCCESS] 访问脚本创建完成")
            else:
                print("\n[ERROR] 访问脚本创建失败")
        
        else:
            network_parser.print_help()

if __name__ == "__main__":
    main()
