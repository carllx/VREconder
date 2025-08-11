# Advanced HEVC Encoder Wrapper for New Structure
# 新结构高级HEVC编码器包装器

param(
    [Parameter(Mandatory=$false)]
    [string]$mediaPath = "D:\Downloads\VR\VR_Video_Processing\04_HEVC_Conversion_Queue",
    [Parameter(Mandatory=$false)]
    [ValidateSet("low", "medium", "high", "ultra")]
    [string]$qualityLevel = "high",
    [Parameter(Mandatory=$false)]
    [switch]$useAIEnhancement,
    [Parameter(Mandatory=$false)]
    [int]$maxConcurrentJobs = 2,
    [Parameter(Mandatory=$false)]
    [switch]$enablePerformanceMonitoring,
    [Parameter(Mandatory=$false)]
    [string]$logFile = "encoding_performance.log"
)

# 设置错误处理
$ErrorActionPreference = "Stop"

# 获取脚本所在目录
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)

# 日志函数
function Write-Log {
    param(
        [string]$Message,
        [string]$Level = "INFO"
    )
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logMessage = "[$timestamp] [$Level] $Message"
    Write-Host $logMessage
    if ($logFile) {
        Add-Content -Path $logFile -Value $logMessage
    }
}

# 检查Python环境
function Test-PythonEnvironment {
    Write-Log "检查Python环境..."
    
    try {
        $pythonVersion = python --version 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Log "Python版本: $pythonVersion" "INFO"
            return $true
        }
    } catch {
        Write-Log "Python未安装或不在PATH中" "ERROR"
        return $false
    }
    
    return $false
}

# 安装依赖
function Install-Dependencies {
    Write-Log "检查并安装依赖..."
    
    $requirementsFile = Join-Path $projectRoot "requirements.txt"
    if (Test-Path $requirementsFile) {
        try {
            Write-Log "安装Python依赖..."
            python -m pip install -r $requirementsFile
            if ($LASTEXITCODE -eq 0) {
                Write-Log "依赖安装成功" "INFO"
                return $true
            }
        } catch {
            Write-Log "依赖安装失败: $($_.Exception.Message)" "ERROR"
            return $false
        }
    }
    
    return $true
}

# 创建Python脚本
function Create-AdvancedEncoderScript {
    $pythonScript = @"
#!/usr/bin/env python3
"""
Advanced HEVC Encoder Script for PowerShell Wrapper
"""

import sys
import json
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent / "src"))

from encoders.advanced_hevc_encoder import AdvancedHEVCEncoder, QualityLevel
from config.settings import Config

def main():
    # Load configuration
    config = Config()
    
    # Initialize encoder
    encoder = AdvancedHEVCEncoder(config)
    
    # Parse arguments
    input_dir = Path("$mediaPath")
    output_dir = input_dir / "HEVC_Advanced_Output"
    
    # Map quality level
    quality_map = {
        "low": QualityLevel.LOW,
        "medium": QualityLevel.MEDIUM,
        "high": QualityLevel.HIGH,
        "ultra": QualityLevel.ULTRA
    }
    quality_level = quality_map.get("$qualityLevel", QualityLevel.HIGH)
    
    # Performance monitoring
    performance_log_file = None
    if "$enablePerformanceMonitoring" -eq "True":
        performance_log_file = Path("$logFile")
    
    # Run batch encoding
    try:
        report = encoder.batch_encode(
            input_dir=input_dir,
            output_dir=output_dir,
            quality_level=quality_level,
            use_ai_enhancement=$useAIEnhancement.IsPresent,
            enable_performance_monitoring="$enablePerformanceMonitoring" -eq "True",
            performance_log_file=performance_log_file
        )
        
        # Output results
        print(json.dumps(report, indent=2))
        
        # Exit with appropriate code
        if report['failed'] == 0:
            sys.exit(0)
        else:
            sys.exit(1)
            
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
"@
    
    $scriptPath = Join-Path $projectRoot "run_advanced_encoder.py"
    $pythonScript | Out-File -FilePath $scriptPath -Encoding UTF8
    return $scriptPath
}

# 主函数
function Main {
    try {
        Write-Log "=== 高级HEVC编码器 (新结构) ===" "INFO"
        Write-Log "质量级别: $qualityLevel" "INFO"
        Write-Log "AI增强: $useAIEnhancement" "INFO"
        Write-Log "并发作业数: $maxConcurrentJobs" "INFO"
        Write-Log "性能监控: $enablePerformanceMonitoring" "INFO"
        
        # 检查Python环境
        if (!(Test-PythonEnvironment)) {
            throw "Python环境检查失败"
        }
        
        # 安装依赖
        if (!(Install-Dependencies)) {
            throw "依赖安装失败"
        }
        
        # 检查输入路径
        if (!(Test-Path $mediaPath)) {
            throw "指定的文件夹不存在: $mediaPath"
        }
        
        # 创建Python脚本
        $pythonScriptPath = Create-AdvancedEncoderScript
        
        # 切换到项目根目录
        Push-Location $projectRoot
        
        try {
            # 运行Python脚本
            Write-Log "启动高级HEVC编码器..." "INFO"
            
            $pythonArgs = @($pythonScriptPath)
            $process = Start-Process -FilePath "python" -ArgumentList $pythonArgs -PassThru -NoNewWindow -Wait
            
            if ($process.ExitCode -eq 0) {
                Write-Log "=== 编码完成 ===" "INFO"
                Write-Log "所有文件处理成功" "INFO"
            } else {
                Write-Log "编码过程中出现错误，退出码: $($process.ExitCode)" "ERROR"
                exit $process.ExitCode
            }
            
        } finally {
            # 恢复目录
            Pop-Location
            
            # 清理临时脚本
            if (Test-Path $pythonScriptPath) {
                Remove-Item $pythonScriptPath -Force
            }
        }
        
    } catch {
        Write-Log "发生错误: $($_.Exception.Message)" "ERROR"
        exit 1
    }
}

# 执行主函数
Main 