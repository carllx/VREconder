# VR Video Processing Pipeline

一个用于自动化处理和重编码 VR 视频的现代化流水线，支持多种格式的批量转换和优化。

## 项目概述

本项目是一个模块化的 VR 视频处理解决方案，包含以下主要功能：

- **视频分类与重命名**：根据分辨率和编码信息自动分类和重命名视频文件
- **视频分割**：支持精准的视频片段提取
- **格式转换**：支持多种编码格式的转换（HEVC、AVC等）
- **批量处理**：支持大规模视频文件的自动化处理
- **质量优化**：智能 CRF 计算和编码参数优化

## 目录结构

```
new_structure/
├── src/                  # 核心源代码
│   ├── main.py           # 主入口 CLI
│   ├── classifiers/      # 视频分类器
│   ├── processors/       # 视频分割处理器
│   ├── encoders/         # 编码器模块（HEVC/高级HEVC）
│   ├── utils/            # 工具函数
│   └── config/           # 配置加载
├── scripts/              # 平台相关脚本（如有）
├── config/               # 配置文件（settings.yaml）
├── docs/                 # 项目文档
├── templates/            # 模板文件
├── requirements.txt      # Python依赖
└── README.md             # 项目说明
```

## 核心模块

- `src/main.py`：统一命令行入口，支持分类、分割、编码、全流程等操作
- `src/classifiers/video_classifier.py`：视频分类与重命名
- `src/processors/video_splitter.py`：视频分割
- `src/encoders/hevc_encoder.py`、`advanced_hevc_encoder.py`：标准/高级HEVC编码
- `src/utils/`：日志、进度、性能监控等工具
- `src/config/settings.py`：配置加载与管理

## 配置说明

所有配置集中在 `config/settings.yaml`，包括路径、编码参数、日志等。

## 使用方法

### 1. 安装依赖
```bash
pip install -r requirements.txt
```

### 2. 配置环境
编辑 `config/settings.yaml`，根据实际路径和需求调整。

### 3. 运行主流程

#### 视频分类
```bash
python src/main.py classify --input-dir <视频目录> --output-report <报告路径>
```

#### 视频分割
```bash
python src/main.py split --input-file <视频文件> --segment-duration 300
```

#### 批量编码
```bash
python src/main.py encode --input-dir <输入目录> --output-dir <输出目录> --encoder libx265 --quality high
```

#### 高级编码
```bash
python src/main.py advanced-encode --input-dir <输入目录> --output-dir <输出目录> --quality ultra --ai-enhancement
```

#### 全流程处理
```bash
python src/main.py pipeline --input-dir <输入目录> --output-dir <输出目录> --quality high --advanced
```

## 日志与监控
- 日志文件：`logs/processing.log`
- 错误日志：`logs/errors.log`

## 贡献指南
1. Fork 项目
2. 创建功能分支
3. 提交更改并推送
4. 创建 Pull Request

## 许可协议
MIT License 