#!/usr/bin/env python3
"""Setup script for VR Video Processing Pipeline."""

from setuptools import setup, find_packages

with open("README.md", "r", encoding="utf-8") as fh:
    long_description = fh.read()

with open("requirements.txt", "r", encoding="utf-8") as fh:
    requirements = [line.strip() for line in fh if line.strip() and not line.startswith("#")]

setup(
    name="vr-video-processing",
    version="2.0.0",
    author="VR Processing Team",
    author_email="team@vr-processing.com",
    description="Automated VR video processing pipeline",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/vr-processing/pipeline",
    packages=find_packages(),
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
    ],
    python_requires=">=3.8",
    install_requires=requirements,
    entry_points={
        "console_scripts": [
            "vr-process=src.main:main",
            "vr-classify=src.classifiers.video_classifier:main",
            "vr-encode=src.encoders.hevc_encoder:main",
            "vr-merge=src.mergers.segment_merger:main",
        ],
    },
)
