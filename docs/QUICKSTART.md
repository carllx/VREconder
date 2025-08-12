# VREconder - 快速开始指南

## 🚀 环境准备

### 1. 安装依赖
```bash
pip install -r requirements.txt
```

### 2. 自动环境配置 (推荐)
```bash
# 完整环境设置
python vreconder.py setup --setup-all

# 或分步配置
python vreconder.py setup --install-deps
python vreconder.py setup --create-dirs
```

### 3. 验证环境
```bash
# FFmpeg环境检测
python vreconder.py maintenance ffmpeg-check --test

# 系统诊断
python vreconder.py maintenance system-diagnose
```

## 🎬 核心功能使用

### 1. 批量视频处理
```bash
# 基本批量处理
python vreconder.py batch --input-dir ./videos --output-dir ./output

# 高质量HEVC编码
python vreconder.py batch \
    --input-dir ./videos \
    --output-dir ./output \
    --encoder libx265 \
    --quality high \
    --max-workers 2

# 模拟运行 (预览处理列表)
python vreconder.py batch \
    --input-dir ./videos \
    --output-dir ./output \
    --dry-run
```

### 2. 单文件处理
```bash
# 单文件编码
python vreconder.py single \
    --input-file "input.mp4" \
    --output-file "output.mp4" \
    --encoder libx265 \
    --quality high
```

### 3. DASH视频分段合并 ✨
```bash
# 合并单个文件夹
python vreconder.py dash-merge ./dash_folder --output ./merged.mp4

# 批量合并多个文件夹 (推荐)
python vreconder.py dash-merge ./dash_folders --batch --workers 4

# 模拟运行 (预览操作)
python vreconder.py dash-merge ./dash_folders --batch --dry-run
```

## 🔧 系统维护

### 环境检查
```bash
# FFmpeg检测
python vreconder.py maintenance ffmpeg-check --test --diagnose

# 系统诊断
python vreconder.py maintenance system-diagnose --full

# 配置验证
python vreconder.py maintenance config-validate
```

### 环境配置
```bash
# 检查环境状态
python vreconder.py setup --check-env

# 安装依赖
python vreconder.py setup --install-deps
```

## 📋 配置说明

- 主要配置集中在 `config/settings.yaml`
- 支持环境变量覆盖
- 自动检测FFmpeg路径

## 🆘 获取帮助

```bash
# 查看主工具帮助
python vreconder.py --help

# 查看子命令帮助
python vreconder.py batch --help
python vreconder.py dash-merge --help
python vreconder.py maintenance --help
```

## ✅ 验证安装

运行以下命令验证安装是否成功：

```bash
# 1. 环境检查
python vreconder.py setup --check-env

# 2. FFmpeg检测
python vreconder.py maintenance ffmpeg-check --test

# 3. 系统诊断
python vreconder.py maintenance system-diagnose
```

---

**🎉 恭喜！你已成功启动 VREconder v3.0！**

如需更详细的使用说明，请参考项目根目录的 [README.md](../README.md)。 