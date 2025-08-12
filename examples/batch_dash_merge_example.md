# 批量DASH合并使用示例

## 🎯 使用场景

当你使用 `Segment2Motrix.js` 下载了多个VR视频的DASH分段后，通常会得到如下的目录结构：

```
C:\Users\carll\Desktop\catDownloads\
├── Video1-Scene1/
│   ├── init.mp4
│   ├── P1-450.056-792.500-0001.m4s
│   ├── P1-450.056-792.500-0002.m4s
│   ├── P2-816.843-958.160-0003.m4s
│   └── ...
├── Video1-Scene2/
│   ├── init.mp4
│   ├── P1-996.447-1267.604-0001.m4s
│   ├── P1-996.447-1267.604-0002.m4s
│   └── ...
├── Video2-FullLength/
│   ├── init.mp4
│   ├── P1-0.000-300.000-0001.m4s
│   ├── P1-0.000-300.000-0002.m4s
│   └── ...
└── ...
```

## 🚀 快速开始

### 1. 扫描预览（推荐第一步）

```bash
# 扫描目录，查看有哪些DASH文件夹
python vreconder.py dash-merge C:\Users\carll\Desktop\catDownloads --batch --dry-run
```

**输出示例：**
```
🔍 扫描目录: C:\Users\carll\Desktop\catDownloads
================================================================================
📁 找到 3 个DASH文件夹:
--------------------------------------------------------------------------------
  1. Video1-Scene1
     📄 文件: 45 m4s + 1 init
     📊 大小: 234.5 MB
     🎬 段落: 2 个 (P1, P2)

  2. Video1-Scene2
     📄 文件: 32 m4s + 1 init
     📊 大小: 187.2 MB
     🎬 段落: 1 个 (P1)

  3. Video2-FullLength
     📄 文件: 120 m4s + 1 init
     📊 大小: 892.7 MB
     🎬 段落: 1 个 (P1)

--------------------------------------------------------------------------------
📊 总计: 3 文件夹, 197 文件, 1314.4 MB
================================================================================

🔍 模拟运行模式 - 不会实际处理文件
```

### 2. 开始批量处理

```bash
# 使用4个并行任务处理
python vreconder.py dash-merge C:\Users\carll\Desktop\catDownloads --batch --workers 4
```

**输出示例：**
```
🎬 VREconder 批量DASH合并
📁 输入目录: C:\Users\carll\Desktop\catDownloads
📁 输出目录: C:\Users\carll\Desktop\catDownloads\merged
🔧 并行任务: 4

[扫描摘要...]

🤔 确定要处理这 3 个文件夹吗? (y/N): y

🚀 开始批量处理 (4 个并行任务)
================================================================================
✅ [1/3] 33.3% | Video1-Scene1 | 15.2s
✅ [2/3] 66.7% | Video1-Scene2 | 12.8s
✅ [3/3] 100.0% | Video2-FullLength | 45.6s

================================================================================
📊 批量处理完成摘要
================================================================================
✅ 成功: 3 个文件夹
❌ 失败: 0 个文件夹
📈 成功率: 100.0%
⏱️  总耗时: 47.3 秒
📄 处理文件: 197 个
📊 处理大小: 1314.4 MB
🚀 平均速度: 27.8 MB/s

📋 详细报告: C:\Users\carll\Desktop\catDownloads\merged\batch_dash_merge_report_20241201_143022.json
================================================================================
```

### 3. 高性能处理（更多并行任务）

```bash
# 使用专用工具，8个并行任务，指定输出目录
python tools/batch_dash_merge.py C:\Users\carll\Desktop\catDownloads -w 8 -o D:\ProcessedVideos
```

## 🔧 高级选项

### 并行任务数调整

- **CPU密集型场景**: 使用 CPU 核心数
- **存储IO受限**: 使用 2-4 个任务
- **网络存储**: 使用 1-2 个任务

```bash
# 根据系统配置调整
python vreconder.py dash-merge ./catDownloads --batch --workers 8  # 8核CPU
python vreconder.py dash-merge ./catDownloads --batch --workers 2  # 机械硬盘
```

### 详细调试

```bash
# 显示详细的文件处理顺序和错误信息
python vreconder.py dash-merge ./single_folder --verbose
```

## 📋 处理报告

每次批量处理后会生成详细的JSON报告，包含：

```json
{
  "summary": {
    "total_folders": 3,
    "successful": 3,
    "failed": 0,
    "success_rate": 100.0,
    "total_time_seconds": 47.3,
    "total_processing_time_seconds": 73.6,
    "total_files_processed": 197,
    "total_size_mb": 1314.4,
    "average_speed_mb_per_second": 27.8,
    "parallel_efficiency": 1.56,
    "timestamp": "2024-12-01T14:30:22"
  },
  "successful_folders": [...],
  "failed_folders": [...]
}
```

## ❗ 常见问题

### Q: 如何选择合适的并行任务数？
A: 从4开始，根据系统性能和存储类型调整：
- SSD + 多核CPU: 6-8
- 机械硬盘: 2-4 
- 网络存储: 1-2

### Q: 处理失败怎么办？
A: 检查报告文件中的错误信息，确保：
- FFmpeg已安装
- 有足够的磁盘空间
- 文件夹包含有效的m4s文件

### Q: 可以中途停止吗？
A: 可以，按Ctrl+C中断，已完成的文件不会丢失。

## 🎬 与Segment2Motrix.js配合使用

1. 使用 `Segment2Motrix.js` 下载DASH分段到 `catDownloads` 目录
2. 运行 `python vreconder.py dash-merge catDownloads --batch --dry-run` 预览
3. 确认无误后运行 `python vreconder.py dash-merge catDownloads --batch --workers 4` 
4. 处理完成后在 `catDownloads/merged/` 目录找到合并后的MP4文件 