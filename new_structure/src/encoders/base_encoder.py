from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Dict, List, Optional

class BaseEncoder(ABC):
    """Abstract base class for all video encoders."""
    def __init__(self, config: Any):
        self.config = config

    @abstractmethod
    def encode_video(self, input_file: Path, output_file: Path, *args, **kwargs) -> bool:
        """Encode a single video file.
        Returns True if successful, False otherwise."""
        pass

    @abstractmethod
    def batch_encode(self, input_files_or_dir, output_dir: Path, *args, **kwargs) -> Any:
        """Batch encode multiple video files.
        Returns a list of results or a report dict."""
        pass

    @abstractmethod
    def generate_encoding_report(self, tasks_or_results: Any) -> Dict:
        """Generate an encoding operation report from batch results."""
        pass 