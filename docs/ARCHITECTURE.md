# VREconder - 架构设计文档

## 🏗️ 项目架构 (v3.0 - 统一CLI架构)

### 整体架构
```
VREconder/
├── vreconder.py               # 🚀 统一CLI入口 (跨平台)
├── tools/                     # 工具模块
│   ├── batch/                 # 批量处理工具
│   │   ├── batch_cli.py       # 批量处理接口
│   │   ├── batch_processor.py # 批量处理逻辑
│   │   └── batch_dash_merge.py # 批量DASH合并 (已测试验证)
│   ├── maintenance/           # 系统维护工具
│   │   ├── ffmpeg_checker.py  # FFmpeg环境检测
│   │   ├── system_diagnose.py # 系统诊断
│   │   └── config_validator.py # 配置验证
│   └── deployment/            # 部署工具
│       ├── install_deps.py    # 依赖安装
│       └── setup_env.py       # 环境配置
├── src/                       # 核心业务逻辑
│   ├── main.py               # 核心功能实现
│   ├── encoders/             # 编码器模块
│   ├── processors/           # 视频处理模块
│   ├── classifiers/          # 视频分类模块
│   ├── combiners/            # 视频合并模块
│   │   └── dash_merger.py    # DASH视频分段合并器 (已测试验证)
│   ├── config/               # 配置管理
│   └── utils/                # 内部工具
├── config/                   # 配置文件
│   └── settings.yaml
└── docs/                     # 文档目录
```

## 🎯 架构设计原则

### 1. 统一入口原则
- **单一CLI工具**: 所有功能通过 `vreconder.py` 统一调用
- **跨平台一致性**: 无需维护平台特定脚本
- **子命令结构**: 清晰的命令层次结构

### 2. 模块化设计
- **功能分离**: 每个模块职责单一，易于维护
- **接口统一**: 标准化的模块接口设计
- **依赖清晰**: 明确的模块依赖关系

### 3. 配置驱动
- **集中配置**: 所有配置集中在 `config/settings.yaml`
- **环境适配**: 自动检测和适配不同环境
- **灵活覆盖**: 支持环境变量和命令行参数覆盖

## 🔧 核心模块说明

### 1. 统一CLI入口 (`vreconder.py`)
- **batch**: 批量视频处理 (编码、分割等)
- **single**: 单文件处理
- **maintenance**: 系统维护和诊断
- **setup**: 环境配置和依赖安装
- **dash-merge**: DASH视频分段合并 ✨

### 2. 批量处理模块 (`tools/batch/`)
- **batch_cli.py**: 批量处理命令行接口
- **batch_processor.py**: 批量处理核心逻辑
- **batch_dash_merge.py**: 批量DASH合并工具 (已测试验证)

### 3. 维护工具模块 (`tools/maintenance/`)
- **ffmpeg_checker.py**: FFmpeg环境检测和诊断
- **system_diagnose.py**: 系统硬件和环境诊断
- **config_validator.py**: 配置文件验证和示例生成

### 4. 核心处理模块 (`src/`)
- **encoders/**: 视频编码器实现
- **processors/**: 视频处理器
- **classifiers/**: 视频分类器
- **combiners/dash_merger.py**: DASH视频分段合并器 (已测试验证)

## 🚀 架构优势

### 1. 跨平台统一
- ✅ **真正跨平台**: 一个Python脚本适配所有操作系统
- ✅ **简化维护**: 无需维护多套平台特定脚本
- ✅ **统一体验**: 所有平台使用相同命令

### 2. 用户友好
- ✅ **直观命令**: 清晰的子命令结构
- ✅ **智能检测**: 自动环境检测和配置
- ✅ **详细反馈**: 实时进度和错误信息

### 3. 易于扩展
- ✅ **模块化**: 新功能可独立开发
- ✅ **接口标准**: 统一的模块接口
- ✅ **配置灵活**: 支持多种配置方式

## 📊 架构演进

### v2.0 → v3.0 主要变化
1. **统一入口**: 从多个平台脚本到单一CLI工具
2. **功能整合**: 所有功能通过统一接口访问
3. **简化维护**: 减少代码重复和维护负担
4. **增强功能**: 新增DASH合并等实用功能

### 重构历程
- **v2.0**: 三层架构 (scripts → tools → src)
- **v2.5**: 架构重构，清理职责混乱
- **v3.0**: 统一CLI架构，简化维护

## 🔮 未来扩展

### 计划中的功能
- **AI增强**: 智能视频质量优化
- **云集成**: 支持云存储和分布式处理
- **插件系统**: 支持第三方功能扩展

---

**📝 说明**: 本架构文档基于 VREconder v3.0.1 编写，反映了项目的最新状态和设计理念。 