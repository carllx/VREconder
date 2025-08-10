# VR Video Processing Pipeline - 快速开始指南

## 环境准备

### 1. 安装依赖
```bash
pip install -r requirements.txt
```

### 2. 配置环境
编辑 `config/settings.yaml`，根据实际路径和需求调整。

## 运行主流程

### 1. 视频分类
```bash
python src/main.py classify --input-dir <视频目录> --output-report <报告路径>
```

### 2. 视频分割
```bash
python src/main.py split --input-file <视频文件> --segment-duration 300
```

### 3. 批量编码
```bash
python src/main.py encode --input-dir <输入目录> --output-dir <输出目录> --encoder libx265 --quality high
```

### 4. 高级编码
```bash
python src/main.py advanced-encode --input-dir <输入目录> --output-dir <输出目录> --quality ultra --ai-enhancement
```

### 5. 全流程处理
```bash
python src/main.py pipeline --input-dir <输入目录> --output-dir <输出目录> --quality high --advanced
```

## 配置说明
- 所有配置集中在 `config/settings.yaml`，包括路径、编码参数、日志等。

## 日志与监控
- 日志文件：`logs/processing.log`
- 错误日志：`logs/errors.log`

## 常见问题
- 确保 FFmpeg、MediaInfo 已正确安装并加入 PATH
- 配置文件路径、参数需与实际环境一致
- 所有操作请通过 main.py CLI 入口完成

---

**恭喜！你已成功启动 VR 视频处理流水线。** 