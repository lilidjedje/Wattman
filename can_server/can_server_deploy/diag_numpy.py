import sys, os, traceback
print('python:', sys.version)
print('cwd:', os.getcwd())
print('\nsys.path:')
for p in sys.path:
    print('-', p)
print('\nlisting cwd:')
for name in sorted(os.listdir('.')):
    print('-', name)
print('\ntrying import numpy...')
try:
    import numpy as np
    print('SUCCESS: numpy loaded from', getattr(np, '__file__', None))
except Exception:
    traceback.print_exc()
