import os
import re
import winreg
import logging
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

def get_steam_path():
    """Find the Steam installation path via the Windows Registry."""
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam")
        steam_path, _ = winreg.QueryValueEx(key, "SteamPath")
        winreg.CloseKey(key)
        return Path(steam_path)
    except Exception as e:
        logger.error(f"Failed to find Steam path in registry: {e}")
        return None

def parse_acf(file_path):
    """Parse a Steam .acf manifest file to get appid and name."""
    try:
        content = file_path.read_text(encoding="utf-8", errors="ignore")
        # Simple regex to extract appid and name
        app_id_match = re.search(r'"appid"\s+"(\d+)"', content)
        name_match = re.search(r'"name"\s+"([^"]+)"', content)
        
        if app_id_match and name_match:
            return {
                "appid": app_id_match.group(1),
                "name": name_match.group(1)
            }
    except Exception as e:
        logger.warning(f"Failed to parse {file_path.name}: {e}")
    return None

def list_steam_games():
    """List all installed Steam games by scanning library folders."""
    steam_path = get_steam_path()
    if not steam_path:
        return {"error": "Steam installation not found."}

    libraries = [steam_path]
    library_folders_vdf = steam_path / "steamapps" / "libraryfolders.vdf"
    
    if library_folders_vdf.exists():
        try:
            content = library_folders_vdf.read_text(encoding="utf-8", errors="ignore")
            # Find all "path" values in libraryfolders.vdf
            paths = re.findall(r'"path"\s+"([^"]+)"', content)
            for p in paths:
                p_path = Path(p.replace("\\\\", "\\"))
                if p_path not in libraries:
                    libraries.append(p_path)
        except Exception as e:
            logger.warning(f"Failed to parse libraryfolders.vdf: {e}")

    games = []
    for lib in libraries:
        apps_dir = lib / "steamapps"
        if not apps_dir.exists():
            continue
            
        for acf_file in apps_dir.glob("appmanifest_*.acf"):
            game_info = parse_acf(acf_file)
            if game_info:
                games.append(game_info)

    # Sort alphabetically
    games.sort(key=lambda x: x["name"].lower())
    
    logger.info(f"Steam: Found {len(games)} installed games.")
    return {"games": games, "count": len(games)}

def launch_steam_game(app_id):
    """Launch a Steam game using the steam://run/ URL scheme."""
    try:
        logger.info(f"Steam: Launching app {app_id}")
        # On Windows, we can use 'start' or 'os.startfile' for URI schemes
        os.startfile(f"steam://run/{app_id}")
        return {"result": f"Launch command sent for app {app_id}", "success": True}
    except Exception as e:
        logger.error(f"Failed to launch Steam game {app_id}: {e}")
        return {"error": str(e), "success": False}
