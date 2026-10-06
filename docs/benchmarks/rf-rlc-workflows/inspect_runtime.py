"""Observe loaded Windows native modules without loading extra DLLs or running a solver."""
import ctypes, hashlib, json, sys
from ctypes import wintypes
from pathlib import Path
from fairbeam import Simulation
sim=Simulation(1e9,2e9)
process=ctypes.windll.kernel32.GetCurrentProcess()
ctypes.windll.kernel32.GetCurrentProcess.restype=wintypes.HANDLE
process=ctypes.windll.kernel32.GetCurrentProcess()
handles=(wintypes.HMODULE*1024)(); needed=wintypes.DWORD()
psapi=ctypes.WinDLL("psapi")
psapi.EnumProcessModules.argtypes=[wintypes.HANDLE,ctypes.POINTER(wintypes.HMODULE),wintypes.DWORD,ctypes.POINTER(wintypes.DWORD)]
psapi.GetModuleFileNameExW.argtypes=[wintypes.HANDLE,wintypes.HMODULE,wintypes.LPWSTR,wintypes.DWORD]
if not psapi.EnumProcessModules(process,handles,ctypes.sizeof(handles),ctypes.byref(needed)): raise ctypes.WinError()
modules=[]
for handle in list(handles)[:needed.value//ctypes.sizeof(wintypes.HMODULE)]:
    name=ctypes.create_unicode_buffer(32768)
    psapi.GetModuleFileNameExW(process,handle,name,len(name))
    path=name.value
    if Path(path).name.lower() in ("openems.dll", "csxcad.dll") or (Path(path).suffix.lower() == ".pyd" and Path(path).parent.name in ("openEMS", "CSXCAD")):
        modules.append({"path":path,"sha256":hashlib.sha256(Path(path).read_bytes()).hexdigest()})
text=json.dumps({"observation":"same configured interpreter and environment, imports only after native runs","executable":sys.executable,"loaded_modules":modules},indent=2)
if len(sys.argv)>1: Path(sys.argv[1]).write_text(text,encoding="utf8")
print(text)
