"""Preserve native getter precision when replaying the periodic-box through XML.

CSXCAD's default writer formats parameterized primitive coordinates at six
decimal places in scientific notation, but grid lines at higher precision.
Never use that mismatch to test an on-grid zero-thickness source.
This adapter deliberately rejects shapes outside the measured periodic-box.
"""
import xml.etree.ElementTree as ET

def number(x):return format(float(x),'.17g')
def xyz(node,v):
    for k,x in zip('XYZ',v):node.set(k,number(x))
def write(sim,path):
    sim.fdtd.Write2XML(str(path));tree=ET.parse(path)
    grid=tree.find('.//RectilinearGrid')
    for a in 'xyz':grid.find(a.upper()+'Lines').text=','.join(map(number,sim.mesh.GetLines(a)))
    props={int(p.get('ID')):p for p in tree.find('.//Properties')}
    for prop in sim.csx.GetAllProperties():
        node=props[prop.GetID()]
        if prop.GetTypeString()=='Material':
            if not prop.GetIsotropy():raise ValueError('anisotropic material outside periodic-box control')
            attrs=node.find('Property')
            for key in ('Epsilon','Mue','Kappa','Sigma'):
                vals=attrs.get(key).split(',');vals[0]=number(prop.GetMaterialProperty(key.lower()));attrs.set(key,','.join(vals))
        shapes=list(node.find('Primitives')); original=prop.GetAllPrimitives()
        assert len(shapes)==len(original)
        for el,p in zip(shapes,original):
            kind=p.GetTypeName()
            if p.HasTransform():raise ValueError('transformed primitive outside periodic-box control')
            if kind=='Box':xyz(el.find('P1'),p.GetStart());xyz(el.find('P2'),p.GetStop())
            else:raise ValueError('unsupported periodic-box primitive '+kind)
    tree.write(path,encoding='utf-8',xml_declaration=True)
