#!/usr/bin/env python3
"""
Network Share Utilities - 网络共享工具模块
遵循项目架构设计原则，提供统一的网络共享功能
"""
import os
import sys
import subprocess
import logging
from pathlib import Path
from typing import Optional, Dict, List, Tuple
from config.settings import Config

logger = logging.getLogger(__name__)

class NetworkShareManager:
    """网络共享管理器 - 遵循项目架构设计原则"""
    
    def __init__(self, config: Config):
        self.config = config
        self.project_root = Path(config.get_path('paths.project_root', '.'))
        self.share_name = config.get('network.share_name', 'VR_Project')
        self.local_ip = self._get_local_ip()
        
    def _get_local_ip(self) -> Optional[str]:
        """获取本机IP地址"""
        try:
            import socket
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            return ip
        except Exception as e:
            logger.error(f"获取本机IP失败: {e}")
            return None
    
    def setup_share(self, share_path: Optional[Path] = None) -> bool:
        """设置文件夹共享 - 遵循配置驱动原则"""
        try:
            if share_path is None:
                share_path = self.project_root
                
            logger.info(f"设置共享: {share_path} -> {self.share_name}")
            
            # 使用PowerShell设置共享
            ps_script = f"""
            # 检查管理员权限
            if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {{
                Write-Host "需要管理员权限" -ForegroundColor Red
                exit 1
            }}
            
            # 创建共享
            New-SmbShare -Name "{self.share_name}" -Path "{share_path}" -FullAccess "Everyone" -ErrorAction SilentlyContinue
            
            # 设置NTFS权限
            $acl = Get-Acl "{share_path}"
            $accessRule = New-Object System.Security.AccessControl.FileSystemAccessRule("Everyone", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
            $acl.SetAccessRule($accessRule)
            Set-Acl -Path "{share_path}" -AclObject $acl
            
            # 配置防火墙
            New-NetFirewallRule -DisplayName "SMB Share Access" -Direction Inbound -Protocol TCP -LocalPort 445 -Action Allow -ErrorAction SilentlyContinue
            Enable-NetFirewallRule -DisplayGroup "File and Printer Sharing" -ErrorAction SilentlyContinue
            
            Write-Host "共享设置完成" -ForegroundColor Green
            """
            
            result = subprocess.run(['powershell', '-Command', ps_script], 
                                  capture_output=True, text=True, shell=True)
            
            if result.returncode == 0:
                logger.info("✓ 共享设置成功")
                return True
            else:
                logger.error(f"共享设置失败: {result.stderr}")
                return False
                
        except Exception as e:
            logger.error(f"设置共享时出错: {e}")
            return False
    
    def get_share_info(self) -> Dict[str, str]:
        """获取共享信息 - 遵循接口统一原则"""
        return {
            'share_name': self.share_name,
            'local_ip': self.local_ip,
            'share_path': f"\\\\{self.local_ip}\\{self.share_name}",
            'computer_name': os.environ.get('COMPUTERNAME', 'Unknown'),
            'project_root': str(self.project_root)
        }
    
    def test_connection(self, target_ip: str) -> bool:
        """测试网络连接 - 遵循单一职责原则"""
        try:
            result = subprocess.run(['ping', '-n', '1', target_ip], 
                                  capture_output=True, text=True)
            return result.returncode == 0
        except Exception as e:
            logger.error(f"连接测试失败: {e}")
            return False
    
    def create_access_script(self, output_path: Path) -> bool:
        """创建访问脚本 - 遵循模块化原则"""
        try:
            share_info = self.get_share_info()
            
            script_content = f"""# ================= 访问共享文件夹脚本 =================
# 在其他电脑上运行此脚本来访问共享文件夹

param(
    [string]$ServerIP = "{share_info['local_ip']}",
    [string]$ShareName = "{share_info['share_name']}",
    [string]$DriveLetter = "Z",
    [switch]$OpenExplorer = $true
)

Write-Host "========== 连接共享文件夹 ==========" -ForegroundColor Cyan
Write-Host "服务器IP: $ServerIP" -ForegroundColor White
Write-Host "共享名称: $ShareName" -ForegroundColor White

$SharePath = "\\\\$ServerIP\\$ShareName"

Write-Host "正在连接共享文件夹..." -ForegroundColor Green

try {{
    # 测试网络连接
    if (-not (Test-Connection $ServerIP -Count 1 -Quiet)) {{
        Write-Host "✗ 无法连接到服务器 $ServerIP" -ForegroundColor Red
        exit 1
    }}
    
    # 断开现有连接
    net use $DriveLetter`: /delete /y 2>$null
    
    # 建立新连接
    $result = net use $DriveLetter`: $SharePath /persistent:yes
    
    if ($LASTEXITCODE -eq 0) {{
        Write-Host "✓ 成功连接到共享文件夹" -ForegroundColor Green
        Write-Host "驱动器路径: $DriveLetter`:" -ForegroundColor White
        
        if ($OpenExplorer) {{
            explorer $DriveLetter`:
        }}
    }} else {{
        Write-Host "✗ 连接失败" -ForegroundColor Red
    }}
}} catch {{
    Write-Host "✗ 连接时出错: $_" -ForegroundColor Red
}}
"""
            
            with open(output_path, 'w', encoding='utf-8') as f:
                f.write(script_content)
            
            logger.info(f"✓ 访问脚本已创建: {output_path}")
            return True
            
        except Exception as e:
            logger.error(f"创建访问脚本失败: {e}")
            return False
    
    def diagnose_network(self) -> Dict[str, any]:
        """网络诊断 - 遵循易扩展原则"""
        diagnosis = {
            'local_ip': self.local_ip,
            'share_name': self.share_name,
            'network_ok': False,
            'share_ok': False,
            'firewall_ok': False,
            'services_ok': False,
            'issues': []
        }
        
        try:
            # 检查网络连接
            if self.local_ip:
                diagnosis['network_ok'] = True
            else:
                diagnosis['issues'].append("无法获取本机IP地址")
            
            # 检查共享状态
            ps_script = f"Get-SmbShare -Name '{self.share_name}' -ErrorAction SilentlyContinue"
            result = subprocess.run(['powershell', '-Command', ps_script], 
                                  capture_output=True, text=True)
            if result.returncode == 0 and self.share_name in result.stdout:
                diagnosis['share_ok'] = True
            else:
                diagnosis['issues'].append("共享未创建或不可访问")
            
            # 检查防火墙
            ps_script = "Get-NetFirewallRule -DisplayName '*SMB*' -ErrorAction SilentlyContinue"
            result = subprocess.run(['powershell', '-Command', ps_script], 
                                  capture_output=True, text=True)
            if result.returncode == 0 and result.stdout.strip():
                diagnosis['firewall_ok'] = True
            else:
                diagnosis['issues'].append("防火墙规则未配置")
            
            # 检查服务状态
            services = ['LanmanServer', 'fdPHost']
            for service in services:
                ps_script = f"Get-Service -Name '{service}' -ErrorAction SilentlyContinue"
                result = subprocess.run(['powershell', '-Command', ps_script], 
                                      capture_output=True, text=True)
                if result.returncode == 0 and 'Running' in result.stdout:
                    diagnosis['services_ok'] = True
                    break
            else:
                diagnosis['issues'].append("网络服务未运行")
                
        except Exception as e:
            diagnosis['issues'].append(f"诊断过程出错: {e}")
        
        return diagnosis

class NetworkShareCLI:
    """网络共享CLI接口 - 遵循统一入口原则"""
    
    def __init__(self, config: Config):
        self.config = config
        self.manager = NetworkShareManager(config)
    
    def setup(self, share_path: Optional[Path] = None) -> bool:
        """设置共享"""
        logger.info("开始设置网络共享...")
        return self.manager.setup_share(share_path)
    
    def info(self) -> None:
        """显示共享信息"""
        share_info = self.manager.get_share_info()
        print("\n========== 共享信息 ==========")
        for key, value in share_info.items():
            print(f"{key}: {value}")
        print("==============================\n")
    
    def diagnose(self) -> None:
        """网络诊断"""
        logger.info("开始网络诊断...")
        diagnosis = self.manager.diagnose_network()
        
        print("\n========== 网络诊断报告 ==========")
        print(f"本机IP: {diagnosis['local_ip']}")
        print(f"共享名称: {diagnosis['share_name']}")
        print(f"网络连接: {'✓' if diagnosis['network_ok'] else '✗'}")
        print(f"共享状态: {'✓' if diagnosis['share_ok'] else '✗'}")
        print(f"防火墙: {'✓' if diagnosis['firewall_ok'] else '✗'}")
        print(f"服务状态: {'✓' if diagnosis['services_ok'] else '✗'}")
        
        if diagnosis['issues']:
            print("\n发现的问题:")
            for issue in diagnosis['issues']:
                print(f"  - {issue}")
        
        print("================================\n")
    
    def create_access_script(self, output_path: Optional[Path] = None) -> bool:
        """创建访问脚本"""
        if output_path is None:
            output_path = self.manager.project_root / "access_share.ps1"
        
        logger.info(f"创建访问脚本: {output_path}")
        return self.manager.create_access_script(output_path) 