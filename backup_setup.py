"""
VR Video Processing Pipeline
A comprehensive solution for VR video re-encoding and processing.
"""

from setuptools import setup, find_packages
import os

# Read the README file
def read_readme():
    with open("README.md", "r", encoding="utf-8") as fh:
        return fh.read()

# Read requirements
def read_requirements():
    with open("requirements.txt", "r", encoding="utf-8") as fh:
        return [line.strip() for line in fh if line.strip() and not line.startswith("#")]

setup(
    name="vr-video-pipeline",
    version="2.0.0",
    author="VR Video Processing Team",
    author_email="team@example.com",
    description="A comprehensive VR video processing pipeline for re-encoding and optimization",
    long_description=read_readme(),
    long_description_content_type="text/markdown",
    url="https://github.com/your-username/vr-video-pipeline",
    packages=find_packages(where="src"),
    package_dir={"": "src"},
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Topic :: Multimedia :: Video",
        "Topic :: Software Development :: Libraries :: Python Modules",
    ],
    python_requires=">=3.8",
    install_requires=read_requirements(),
    extras_require={
        "dev": [
            "pytest>=7.4.0",
            "pytest-cov>=4.1.0",
            "black>=23.0.0",
            "flake8>=6.0.0",
            "mypy>=1.5.0",
            "pre-commit>=3.3.0",
        ],
        "web": [
            "fastapi>=0.100.0",
            "uvicorn>=0.23.0",
            "jinja2>=3.1.0",
        ],
    },
    entry_points={
        "console_scripts": [
            "vr-pipeline=vr_pipeline.cli:main",
        ],
    },
    include_package_data=True,
    package_data={
        "vr_pipeline": ["config/*.yaml", "templates/*"],
    },
    keywords="video processing, VR, HEVC, encoding, ffmpeg",
    project_urls={
        "Bug Reports": "https://github.com/your-username/vr-video-pipeline/issues",
        "Source": "https://github.com/your-username/vr-video-pipeline",
        "Documentation": "https://github.com/your-username/vr-video-pipeline/docs",
    },
) 