# VR Video Processing Pipeline - 重构任务清单

## 📋 重构概述

本清单详细列出了将现有VR视频处理流水线项目重构为模块化架构的完整任务计划。重构将分阶段进行，确保功能稳定性和向后兼容性。

## 🎯 重构目标

- **模块化架构**: 创建清晰的模块分离和职责划分
- **配置驱动**: 消除硬编码，实现配置集中管理
- **跨平台兼容**: 统一Windows和macOS脚本接口
- **性能优化**: 实现并行处理和内存优化
- **质量提升**: 完善错误处理、日志记录和测试覆盖

## 📅 重构阶段

### 第一阶段：基础架构搭建 (1-2周)

#### 1.1 目录结构创建
- [ ] **创建核心目录结构**
  ```bash
  mkdir -p src/{classifiers,processors,encoders,mergers,utils,config}
  mkdir -p scripts/{windows,macos,cross-platform}
  mkdir -p config logs tests docs templates tools
  ```

- [ ] **创建Python包结构**
  ```bash
  # 在每个src子目录中创建__init__.py文件
  touch src/__init__.py
  touch src/classifiers/__init__.py
  touch src/processors/__init__.py
  touch src/encoders/__init__.py
  touch src/mergers/__init__.py
  touch src/utils/__init__.py
  touch src/config/__init__.py
  ```

#### 1.2 依赖分析工具开发
- [ ] **创建依赖分析器** (`tools/dependency_analyzer.py`)
  - [ ] 静态代码分析功能
  - [ ] 文件依赖关系检测
  - [ ] 重复代码识别
  - [ ] 硬编码路径/参数检测
  - [ ] 复杂度分析
  - [ ] 生成依赖关系图
  - [ ] 生成分析报告

- [ ] **创建脚本迁移工具** (`tools/script_migrator.py`)
  - [ ] 自动迁移脚本到新目录结构
  - [ ] 配置文件模板生成
  - [ ] 依赖关系更新
  - [ ] 路径引用修正
  - [ ] 干运行模式支持

#### 1.3 配置系统建立
- [ ] **创建主配置文件** (`config/settings.yaml`)
  ```yaml
  app:
    name: "VR Video Processing Pipeline"
    version: "2.0.0"
    debug: false
  
  paths:
    download: "D:\Downloads\VR\VR_Video_Processing/01_Download_Completed"
    output: "D:\Downloads\VR\VR_Video_Processing/Output"
    temp: "D:\Downloads\VR\VR_Video_Processing/Temp"
  
  encoding:
    hevc:
      preset: "slower"
      crf_range:
        min: 20
        max: 38
      profile: "main10"
  ```

- [ ] **创建路径配置文件** (`config/paths.yaml`)
- [ ] **创建编码配置文件** (`config/encoding.yaml`)
- [ ] **创建日志配置文件** (`config/logging.yaml`)

#### 1.4 基础工具模块
- [ ] **创建配置管理器** (`src/config/settings.py`)
  - [ ] YAML配置文件加载
  - [ ] 环境变量覆盖支持
  - [ ] 配置验证功能
  - [ ] 默认值处理

- [ ] **创建日志管理器** (`src/utils/logging.py`)
  - [ ] 结构化日志格式
  - [ ] 日志级别控制
  - [ ] 日志轮转功能
  - [ ] 性能监控日志

- [ ] **创建路径工具** (`src/utils/path_utils.py`)
  - [ ] 跨平台路径处理
  - [ ] 路径验证功能
  - [ ] 相对路径转换
  - [ ] UNC路径支持

### 第二阶段：核心模块迁移 (2-3周)

#### 2.1 视频分类器模块
- [ ] **分析现有分类器** (`01_VR_Video_Resolution_Classifier.ps1`)
  - [ ] 提取核心逻辑
  - [ ] 识别硬编码路径
  - [ ] 分析依赖关系
  - [ ] 确定接口设计

- [ ] **创建Python分类器** (`src/classifiers/video_classifier.py`)
  ```python
  class VideoClassifier:
      def __init__(self, config: Config):
          self.config = config
          self.logger = get_logger(__name__)
      
      def classify_videos(self, source_path: str) -> Dict[str, List[str]]:
          """根据分辨率和编码信息分类视频"""
          pass
      
      def rename_videos(self, video_path: str) -> str:
          """重命名视频文件"""
          pass
  ```

- [ ] **创建分辨率检测器** (`src/classifiers/resolution_detector.py`)
- [ ] **创建编码格式检测器** (`src/classifiers/codec_detector.py`)
- [ ] **创建PowerShell包装器** (`scripts/windows/classify_videos.ps1`)

#### 2.2 视频分割器模块
- [ ] **分析现有分割器** (`02_4K_Split_and_Merge.py`)
  - [ ] 提取LLC文件解析逻辑
  - [ ] 分析FFmpeg命令构建
  - [ ] 识别错误处理模式
  - [ ] 确定配置需求

- [ ] **创建Python分割器** (`src/processors/video_splitter.py`)
  ```python
  class VideoSplitter:
      def __init__(self, config: Config):
          self.config = config
          self.logger = get_logger(__name__)
      
      def split_video(self, video_path: str, llc_path: str) -> List[str]:
          """基于LLC文件分割视频"""
          pass
      
      def merge_segments(self, segments: List[str], output_path: str) -> str:
          """合并视频片段"""
          pass
  ```

- [ ] **创建LLC解析器** (`src/processors/llc_parser.py`)
- [ ] **创建片段处理器** (`src/processors/segment_processor.py`)
- [ ] **创建跨平台接口** (`scripts/cross-platform/split_video.py`)

#### 2.3 HEVC编码器模块
- [ ] **分析现有编码器**
  - [ ] `batch_to_HEVC_libx265.ps1`
  - [ ] `batch_to_HEVC_hevc_nvenc.ps1`
  - [ ] `04_Batch_toHEVC(PC).ps1`
  - [ ] `04_batch_toHEVC(macOS).sh`

- [ ] **创建Python编码器** (`src/encoders/hevc_encoder.py`)
  ```python
  class HEVCEncoder:
      def __init__(self, config: Config):
          self.config = config
          self.logger = get_logger(__name__)
      
      def calculate_crf(self, video_info: VideoInfo) -> float:
          """智能计算CRF值"""
          pass
      
      def encode_video(self, input_path: str, output_path: str) -> str:
          """编码视频为HEVC格式"""
          pass
  ```

- [ ] **创建编码器工厂** (`src/encoders/encoder_factory.py`)
- [ ] **创建CRF计算器** (`src/encoders/crf_calculator.py`)
- [ ] **创建PowerShell包装器** (`scripts/windows/encode_hevc.ps1`)
- [ ] **创建Bash包装器** (`scripts/macos/encode_hevc.sh`)

#### 2.4 片段合并器模块
- [ ] **分析现有合并器**
  - [ ] `MergeDash.ps1`
  - [ ] `BatchMergeDash.ps1`
  - [ ] `BatchMergeDash.sh`

- [ ] **创建Python合并器** (`src/mergers/segment_merger.py`)
  ```python
  class SegmentMerger:
      def __init__(self, config: Config):
          self.config = config
          self.logger = get_logger(__name__)
      
      def merge_dash_segments(self, segments: List[str], output_path: str) -> str:
          """合并DASH格式片段"""
          pass
      
      def batch_merge(self, segment_dirs: List[str]) -> List[str]:
          """批量合并片段"""
          pass
  ```

- [ ] **创建DASH合并器** (`src/mergers/dash_merger.py`)
- [ ] **创建批量合并器** (`src/mergers/batch_merger.py`)
- [ ] **创建跨平台接口** (`scripts/cross-platform/merge_segments.py`)

### 第三阶段：工具模块完善 (1-2周)

#### 3.1 媒体信息工具
- [ ] **创建媒体信息提取器** (`src/utils/media_info.py`)
  ```python
  class MediaInfoExtractor:
      def __init__(self, config: Config):
          self.config = config
          self.logger = get_logger(__name__)
      
      def get_video_info(self, video_path: str) -> VideoInfo:
          """获取视频详细信息"""
          pass
      
      def validate_video_file(self, video_path: str) -> bool:
          """验证视频文件完整性"""
          pass
  ```

- [ ] **创建视频信息数据类** (`src/utils/video_info.py`)
- [ ] **创建MediaInfo包装器** (`src/utils/mediainfo_wrapper.py`)

#### 3.2 文件操作工具
- [ ] **创建文件操作工具** (`src/utils/file_utils.py`)
  ```python
  class FileUtils:
      @staticmethod
      def safe_move(source: str, target: str) -> bool:
          """安全移动文件"""
          pass
      
      @staticmethod
      def safe_copy(source: str, target: str) -> bool:
          """安全复制文件"""
          pass
      
      @staticmethod
      def get_video_files(directory: str) -> List[str]:
          """获取目录中的视频文件"""
          pass
  ```

- [ ] **创建文件验证器** (`src/utils/file_validator.py`)
- [ ] **创建文件重命名器** (`src/utils/file_renamer.py`)

#### 3.3 错误处理工具
- [ ] **创建异常类** (`src/utils/exceptions.py`)
  ```python
  class VideoProcessingError(Exception):
      """视频处理错误基类"""
      pass
  
  class EncodingError(VideoProcessingError):
      """编码错误"""
      pass
  
  class FileNotFoundError(VideoProcessingError):
      """文件未找到错误"""
      pass
  ```

- [ ] **创建错误处理器** (`src/utils/error_handler.py`)
- [ ] **创建重试机制** (`src/utils/retry.py`)

### 第四阶段：测试框架建立 (1-2周)

#### 4.1 测试基础设施
- [ ] **创建测试配置** (`tests/conftest.py`)
- [ ] **创建测试数据管理器** (`tests/data_manager.py`)
- [ ] **创建测试工具函数** (`tests/utils.py`)

#### 4.2 单元测试
- [ ] **视频分类器测试** (`tests/test_video_classifier.py`)
- [ ] **视频分割器测试** (`tests/test_video_splitter.py`)
- [ ] **HEVC编码器测试** (`tests/test_hevc_encoder.py`)
- [ ] **片段合并器测试** (`tests/test_segment_merger.py`)
- [ ] **工具模块测试** (`tests/test_utils.py`)

#### 4.3 集成测试
- [ ] **完整流水线测试** (`tests/integration/test_pipeline.py`)
- [ ] **跨平台兼容性测试** (`tests/integration/test_cross_platform.py`)
- [ ] **性能基准测试** (`tests/integration/test_performance.py`)

#### 4.4 测试配置
- [ ] **pytest配置** (`pytest.ini`)
- [ ] **覆盖率配置** (`.coveragerc`)
- [ ] **测试数据文件** (`tests/data/`)

### 第五阶段：脚本迁移和清理 (1-2周)

#### 5.1 脚本迁移
- [ ] **迁移PowerShell脚本**
  - [ ] `01_VR_Video_Resolution_Classifier.ps1` → `scripts/windows/classify_videos.ps1`
  - [ ] `batch_to_HEVC_libx265.ps1` → `scripts/windows/encode_hevc_libx265.ps1`
  - [ ] `batch_to_HEVC_hevc_nvenc.ps1` → `scripts/windows/encode_hevc_nvenc.ps1`
  - [ ] `MergeDash.ps1` → `scripts/windows/merge_dash.ps1`
  - [ ] `BatchMergeDash.ps1` → `scripts/windows/batch_merge_dash.ps1`

- [ ] **迁移Bash脚本**
  - [ ] `04_batch_toHEVC(macOS).sh` → `scripts/macos/encode_hevc.sh`
  - [ ] `BatchMergeDash.sh` → `scripts/macos/batch_merge_dash.sh`

- [ ] **迁移Python脚本**
  - [ ] `02_4K_Split_and_Merge.py` → `src/processors/video_splitter.py`
  - [ ] `calculateSegment.CatCatch.js` → `src/utils/segment_calculator.py`

#### 5.2 依赖关系管理
- [ ] **更新脚本引用**
  - [ ] 修正相对路径引用
  - [ ] 更新配置文件路径
  - [ ] 修正模块导入语句

- [ ] **创建依赖关系图**
  - [ ] 生成模块依赖图
  - [ ] 生成脚本调用关系图
  - [ ] 识别循环依赖

#### 5.3 清理工作
- [ ] **删除重复文件**
  - [ ] 识别功能重复的脚本
  - [ ] 保留最佳实现
  - [ ] 删除过时文件

- [ ] **清理临时文件**
  - [ ] 删除测试产生的临时文件
  - [ ] 清理日志文件
  - [ ] 整理备份文件

### 第六阶段：性能优化 (1-2周)

#### 6.1 并行处理
- [ ] **实现多进程处理** (`src/utils/parallel_processor.py`)
  ```python
  class ParallelProcessor:
      def __init__(self, config: Config):
          self.config = config
          self.logger = get_logger(__name__)
      
      def process_videos_parallel(self, video_paths: List[str], 
                                processor_func: Callable) -> List[ProcessResult]:
          """并行处理视频文件"""
          pass
  ```

- [ ] **创建任务队列管理器** (`src/utils/task_queue.py`)
- [ ] **实现进度监控** (`src/utils/progress_monitor.py`)

#### 6.2 内存优化
- [ ] **实现流式处理** (`src/utils/stream_processor.py`)
- [ ] **创建内存监控器** (`src/utils/memory_monitor.py`)
- [ ] **优化大文件处理** (`src/utils/large_file_handler.py`)

#### 6.3 缓存机制
- [ ] **创建视频信息缓存** (`src/utils/cache_manager.py`)
- [ ] **实现处理结果缓存** (`src/utils/result_cache.py`)
- [ ] **创建配置缓存** (`src/utils/config_cache.py`)

### 第七阶段：文档和部署 (1周)

#### 7.1 文档完善
- [ ] **更新README文档** (`README.md`)
- [ ] **创建API文档** (`docs/api.md`)
- [ ] **创建用户指南** (`docs/user_guide.md`)
- [ ] **创建开发者文档** (`docs/developer_guide.md`)
- [ ] **创建迁移指南** (`docs/migration_guide.md`)

#### 7.2 部署准备
- [ ] **创建requirements.txt**
- [ ] **创建setup.py**
- [ ] **创建Docker支持** (`Dockerfile`, `docker-compose.yml`)
- [ ] **创建conda环境文件** (`environment.yml`)

#### 7.3 配置验证
- [ ] **创建配置验证器** (`src/config/validator.py`)
- [ ] **创建环境检查脚本** (`tools/check_environment.py`)
- [ ] **创建安装脚本** (`tools/install.py`)

## 🔍 检测任务

### 依赖检测任务
- [ ] **静态依赖分析**
  - [ ] 分析所有脚本文件的import/require语句
  - [ ] 识别外部工具依赖（FFmpeg, MediaInfo等）
  - [ ] 检测文件路径依赖
  - [ ] 生成依赖关系矩阵

- [ ] **动态依赖分析**
  - [ ] 运行时依赖检测
  - [ ] 条件依赖分析
  - [ ] 平台特定依赖识别

- [ ] **依赖冲突检测**
  - [ ] 版本冲突识别
  - [ ] 循环依赖检测
  - [ ] 缺失依赖警告

### 重复代码检测任务
- [ ] **代码相似度分析**
  - [ ] 使用工具检测重复代码片段
  - [ ] 识别功能重复的函数
  - [ ] 检测相似的配置模式
  - [ ] 生成重复代码报告

- [ ] **功能重复检测**
  - [ ] 分析脚本功能重叠
  - [ ] 识别可合并的脚本
  - [ ] 检测冗余的配置项

### 硬编码值检测任务
- [ ] **路径硬编码检测**
  - [ ] 扫描所有文件中的绝对路径
  - [ ] 识别项目特定路径模式
  - [ ] 检测平台特定路径

- [ ] **参数硬编码检测**
  - [ ] 识别编码参数硬编码
  - [ ] 检测配置值硬编码
  - [ ] 发现魔法数字和字符串

- [ ] **硬编码值提取**
  - [ ] 自动提取硬编码值到配置文件
  - [ ] 生成配置模板
  - [ ] 创建迁移脚本

### 代码质量检测任务
- [ ] **复杂度分析**
  - [ ] 计算圈复杂度
  - [ ] 识别复杂函数
  - [ ] 检测嵌套层级过深的代码

- [ ] **代码规范检查**
  - [ ] 使用flake8检查Python代码
  - [ ] 使用PSScriptAnalyzer检查PowerShell代码
  - [ ] 使用shellcheck检查Bash代码

- [ ] **类型检查**
  - [ ] 使用mypy进行类型检查
  - [ ] 添加类型注解
  - [ ] 修复类型错误

### 性能检测任务
- [ ] **性能基准测试**
  - [ ] 测量处理时间
  - [ ] 监控内存使用
  - [ ] 检测CPU使用率

- [ ] **瓶颈识别**
  - [ ] 使用cProfile进行性能分析
  - [ ] 识别慢速操作
  - [ ] 检测内存泄漏

### 兼容性检测任务
- [ ] **跨平台兼容性**
  - [ ] 检测平台特定代码
  - [ ] 验证路径分隔符使用
  - [ ] 检查文件权限处理

- [ ] **版本兼容性**
  - [ ] 检查Python版本兼容性
  - [ ] 验证PowerShell版本要求
  - [ ] 检测依赖版本冲突

## 📊 进度跟踪

### 进度指标
- [ ] **完成度跟踪**
  - [ ] 模块迁移完成度
  - [ ] 测试覆盖率
  - [ ] 文档完整性
  - [ ] 性能提升程度

- [ ] **质量指标**
  - [ ] 代码复杂度降低
  - [ ] 重复代码消除
  - [ ] 硬编码值减少
  - [ ] 错误率降低

### 里程碑检查点
- [ ] **第一阶段完成** - 基础架构搭建完成
- [ ] **第二阶段完成** - 核心模块迁移完成
- [ ] **第三阶段完成** - 工具模块完善完成
- [ ] **第四阶段完成** - 测试框架建立完成
- [ ] **第五阶段完成** - 脚本迁移和清理完成
- [ ] **第六阶段完成** - 性能优化完成
- [ ] **第七阶段完成** - 文档和部署完成

## 🚨 风险控制

### 风险评估
- [ ] **功能风险**
  - [ ] 重构过程中功能丢失
  - [ ] 接口变更导致兼容性问题
  - [ ] 配置错误导致系统故障

- [ ] **性能风险**
  - [ ] 重构后性能下降
  - [ ] 内存使用增加
  - [ ] 处理速度变慢

- [ ] **时间风险**
  - [ ] 重构时间超出预期
  - [ ] 依赖问题导致延迟
  - [ ] 测试时间不足

### 风险缓解措施
- [ ] **备份策略**
  - [ ] 创建重构前完整备份
  - [ ] 使用版本控制管理变更
  - [ ] 准备回滚方案

- [ ] **测试策略**
  - [ ] 每个阶段完成后进行测试
  - [ ] 保持回归测试
  - [ ] 进行性能基准测试

- [ ] **渐进式迁移**
  - [ ] 分阶段进行重构
  - [ ] 保持向后兼容性
  - [ ] 提供迁移工具

## 📝 验收标准

### 功能验收
- [ ] **核心功能正常**
  - [ ] 视频分类功能正常
  - [ ] 视频分割功能正常
  - [ ] HEVC编码功能正常
  - [ ] 片段合并功能正常

- [ ] **配置系统正常**
  - [ ] 配置文件加载正常
  - [ ] 环境变量覆盖正常
  - [ ] 配置验证正常

- [ ] **错误处理完善**
  - [ ] 异常捕获和处理正常
  - [ ] 错误信息清晰
  - [ ] 错误恢复机制正常

### 性能验收
- [ ] **处理速度**
  - [ ] 处理速度不低于原版本
  - [ ] 并行处理效果明显
  - [ ] 内存使用合理

- [ ] **稳定性**
  - [ ] 长时间运行稳定
  - [ ] 大文件处理正常
  - [ ] 并发处理稳定

### 质量验收
- [ ] **代码质量**
  - [ ] 测试覆盖率 > 80%
  - [ ] 代码复杂度降低 30%
  - [ ] 重复代码消除 > 50%

- [ ] **文档质量**
  - [ ] API文档完整
  - [ ] 用户指南清晰
  - [ ] 迁移指南详细

## 🎯 成功标准

### 技术指标
- [ ] **架构指标**
  - [ ] 模块化程度 > 90%
  - [ ] 配置集中管理 100%
  - [ ] 跨平台兼容性 100%

- [ ] **质量指标**
  - [ ] 测试覆盖率 > 80%
  - [ ] 代码复杂度降低 30%
  - [ ] 错误率降低 50%

- [ ] **性能指标**
  - [ ] 处理速度提升 20%
  - [ ] 内存使用减少 30%
  - [ ] 启动时间减少 40%

### 业务指标
- [ ] **可维护性**
  - [ ] 新功能开发时间减少 50%
  - [ ] 问题修复时间减少 60%
  - [ ] 代码审查效率提升 40%

- [ ] **用户体验**
  - [ ] 错误信息清晰易懂
  - [ ] 配置简单直观
  - [ ] 处理进度实时显示

---

**注意**: 本任务清单是动态文档，会根据重构过程中的实际情况进行调整和更新。每个任务完成后应及时更新状态，并记录遇到的问题和解决方案。 