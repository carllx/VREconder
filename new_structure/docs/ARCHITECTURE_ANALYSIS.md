# VR Video Processing Pipeline - 架构分析报告

## 项目结构

```
new_structure/
├── src/
│   ├── main.py
│   ├── classifiers/
│   │   └── video_classifier.py
│   ├── processors/
│   │   └── video_splitter.py
│   ├── encoders/
│   │   ├── hevc_encoder.py
│   │   ├── advanced_hevc_encoder.py
│   │   └── base_encoder.py
│   ├── utils/
│   │   ├── logging.py
│   │   ├── progress_monitor.py
│   │   ├── performance_monitor.py
│   │   └── ...
│   └── config/
│       └── settings.py
├── config/
│   └── settings.yaml
├── scripts/
├── docs/
├── templates/
```

## 核心模块设计

### 1. 分类器 (classifiers)
- `video_classifier.py`：负责视频分辨率、编码格式等自动分类与重命名。

### 2. 分割器 (processors)
- `video_splitter.py`：负责视频分割，支持批量和精准分段。

### 3. 编码器 (encoders)
- `hevc_encoder.py`：标准HEVC编码，支持多种编码器（libx265、nvenc等）。
- `advanced_hevc_encoder.py`：高级HEVC编码，支持CUDA/AI增强、性能监控。
- `base_encoder.py`：编码器抽象基类，统一接口。

### 4. 工具 (utils)
- 日志、进度、性能监控、路径解析等通用工具。

### 5. 配置 (config)
- `settings.py`：配置加载与管理。
- `settings.yaml`：唯一权威配置文件。

## 统一入口

所有功能均通过 `src/main.py` CLI 入口统一调用，支持分类、分割、编码、全流程等操作。

## 配置管理

- 所有路径、参数、日志等均集中在 `config/settings.yaml`。
- 通过 `src/config/settings.py` 加载，支持多变量解析。

## 典型流程

1. 视频分类
2. 视频分割
3. 批量/高级编码
4. （可选）合并片段（如后续实现）

## 设计原则
- 单一职责、模块化、配置驱动、接口统一、易扩展
- 所有脚本和工具均通过 main.py 统一入口调用

## 说明
- 合并器（mergers）等模块如未实现，已从主流程移除，后续如需可扩展。
- 仅保留主线功能和配置，所有 legacy、tests、examples、mergers 等已归档/删除。 