# FFmpeg 自动路径检测功能

## 概述

VREconder 项目现在具备了强大的跨平台 FFmpeg 路径自动检测功能，无需手动配置即可在不同系统环境下自动找到并使用正确的 FFmpeg 安装位置。

## 支持的检测方式

### 1. 配置文件优先
- **Windows**: `config/settings.yaml` 中的 `paths.windows.ffmpeg_path`
- **macOS**: `config/settings.yaml` 中的 `paths.macos.ffmpeg_path`  
- **Linux**: `config/settings.yaml` 中的 `paths.linux.ffmpeg_path`

### 2. 系统 PATH 环境变量
- 自动检测系统 PATH 中的 `ffmpeg` 命令
- 支持通过包管理器安装的 FFmpeg

### 3. 常见安装路径自动扫描

#### Windows 常见路径
```
C:/ffmpeg/bin/ffmpeg.exe
C:/ffmpeg-7.1.1-full_build/bin/ffmpeg.exe
C:/ffmpeg-6.1-full_build/bin/ffmpeg.exe
C:/ffmpeg-5.1-full_build/bin/ffmpeg.exe
C:/Program Files/ffmpeg/bin/ffmpeg.exe
C:/Program Files (x86)/ffmpeg/bin/ffmpeg.exe
D:/ffmpeg/bin/ffmpeg.exe
E:/ffmpeg/bin/ffmpeg.exe
%USERPROFILE%/ffmpeg/bin/ffmpeg.exe
./ffmpeg/bin/ffmpeg.exe
./ffmpeg.exe
```

#### macOS 常见路径
```
/usr/local/bin/ffmpeg
/usr/bin/ffmpeg
/opt/homebrew/bin/ffmpeg          # Apple Silicon Homebrew
/usr/local/homebrew/bin/ffmpeg    # Intel Homebrew
/opt/local/bin/ffmpeg             # MacPorts
~/homebrew/bin/ffmpeg
~/opt/homebrew/bin/ffmpeg
/Applications/ffmpeg.app/Contents/MacOS/ffmpeg
```

#### Linux 常见路径
```
/usr/local/bin/ffmpeg
/usr/bin/ffmpeg
/opt/ffmpeg/bin/ffmpeg
/snap/bin/ffmpeg                  # Snap 包
~/.local/bin/ffmpeg
~/bin/ffmpeg
./ffmpeg
```

### 4. 包管理器安装路径
- **macOS**: Homebrew, MacPorts
- **Linux**: Snap, Flatpak

### 5. 环境变量支持
- `FFMPEG_PATH`
- `FFMPEG_HOME` 
- `FFMPEG_BIN`

### 6. 项目本地路径
- 项目根目录下的 `ffmpeg/bin/` 文件夹

## 使用方法

### 基本使用

```python
from src.utils.ffmpeg_detector import detect_ffmpeg_path, detect_ffprobe_path

# 自动检测 FFmpeg 路径
ffmpeg_path = detect_ffmpeg_path(config)

# 自动检测 FFprobe 路径
ffprobe_path = detect_ffprobe_path(config)
```

### 高级使用

```python
from src.utils.ffmpeg_detector import FFmpegDetector

# 创建检测器实例
detector = FFmpegDetector(config)

# 检测 FFmpeg 路径
ffmpeg_path = detector.detect_ffmpeg_path()

# 检测 FFprobe 路径
ffprobe_path = detector.detect_ffprobe_path()

# 测试安装
is_working, version_info = detector.test_ffmpeg_installation()

# 获取检测摘要
summary = detector.get_detection_summary()
```

### 在现有代码中的集成

所有相关的编码器和处理器类已经自动更新为使用新的检测器：

- `HEVCEncoder`
- `AdvancedHEVCEncoder` 
- `VideoSplitter`
- `VideoClassifier`

## 配置示例

### settings.yaml 配置

```yaml
paths:
  windows:
    ffmpeg_path: "D:/ffmpeg-7.1.1-full_build/bin/ffmpeg.exe"
    mediainfo_path: "C:/mediainfo/mediainfo.exe"
  macos:
    ffmpeg_path: "/usr/local/bin/ffmpeg"
    mediainfo_path: "/usr/local/bin/mediainfo"
  linux:
    ffmpeg_path: "/usr/bin/ffmpeg"
    mediainfo_path: "/usr/bin/mediainfo"
```

### 环境变量配置

```bash
# Windows
set FFMPEG_PATH=C:\ffmpeg\bin

# macOS/Linux
export FFMPEG_PATH=/usr/local/bin
```

## 检测优先级

1. **配置文件路径** (最高优先级)
2. **系统 PATH 环境变量**
3. **常见安装路径**
4. **包管理器安装路径**
5. **用户自定义路径**
6. **项目本地路径**

## 错误处理

当找不到 FFmpeg 时，系统会提供详细的安装指导：

### Windows
```
FFmpeg 未找到！请按以下步骤安装：
1. 下载 FFmpeg: https://ffmpeg.org/download.html
2. 解压到 C:/ffmpeg/ 目录
3. 将 C:/ffmpeg/bin/ 添加到系统 PATH 环境变量
4. 或在 config/settings.yaml 中指定 ffmpeg_path
```

### macOS
```
FFmpeg 未找到！请按以下步骤安装：
1. 使用 Homebrew: brew install ffmpeg
2. 或使用 MacPorts: sudo port install ffmpeg
3. 或在 config/settings.yaml 中指定 ffmpeg_path
```

### Linux
```
FFmpeg 未找到！请按以下步骤安装：
1. Ubuntu/Debian: sudo apt install ffmpeg
2. CentOS/RHEL: sudo yum install ffmpeg
3. 或使用 Snap: sudo snap install ffmpeg
4. 或在 config/settings.yaml 中指定 ffmpeg_path
```

## 测试功能

运行测试脚本验证检测功能：

```bash
python test_ffmpeg_detector.py
```

测试内容包括：
- 基本路径检测
- 便捷函数测试
- 错误处理测试
- 跨平台兼容性

## 优势特性

✅ **全自动检测**: 无需手动配置路径  
✅ **跨平台支持**: Windows、macOS、Linux 全覆盖  
✅ **智能优先级**: 多种检测方式按优先级排序  
✅ **容错性强**: 多层检测，提高成功率  
✅ **详细日志**: 完整的检测过程记录  
✅ **友好错误**: 清晰的安装指导信息  
✅ **向后兼容**: 不影响现有配置  

## 技术实现

- **模块化设计**: 独立的 `FFmpegDetector` 类
- **便捷函数**: 提供简单的函数接口
- **配置集成**: 与现有配置系统无缝集成
- **异常处理**: 完善的错误处理和日志记录
- **性能优化**: 避免重复检测，提高效率

## 更新日志

- **v2.0.0**: 新增跨平台 FFmpeg 自动检测功能
- 支持 Windows、macOS、Linux 三大平台
- 集成到所有相关编码器和处理器类
- 提供详细的检测摘要和错误指导 