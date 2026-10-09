import subprocess, json, xml.etree.ElementTree as ET

def run_guards(exe, template, out):
    out.mkdir(parents=True,exist_ok=False)
    cases={'unpaired':'paired x/y','nonuniform':'uniform transverse','sse':'basic Cartesian','z-periodic':'paired x/y','sphere':'axis-aligned','cell-constant':'quarter-cell','automatic-dt':'explicit timestep','unsafe-dt':'explicit timestep','weight':'spatially constant','anisotropy':'passive isotropic','active':'passive isotropic','hard-source':'soft electric'}
    results={}
    for case,expected in cases.items():
        d=out/case;d.mkdir();tree=ET.parse(template);bc=tree.find('.//BoundaryCond');fdtd=tree.find('.//FDTD');mat=tree.find('.//Material');prop=mat.find('Property')
        if case=='unpaired':bc.set('xmin','PEC')
        elif case=='nonuniform':
            node=tree.find('.//XLines');v=list(map(float,node.text.split(',')));v[2]+=.01;node.text=','.join(map(str,v))
        elif case=='z-periodic':bc.set('zmin','PERIODIC_TEST');bc.set('zmax','PERIODIC_TEST')
        elif case=='sphere':
            primitives=mat.find('Primitives');primitives.clear();sphere=ET.SubElement(primitives,'Sphere',{'Priority':'0','Radius':'1'});ET.SubElement(sphere,'Center',{'X':'0','Y':'0','Z':'1'})
        elif case=='cell-constant':fdtd.set('CellConstantMaterial','1')
        elif case=='automatic-dt':fdtd.attrib.pop('TimeStep',None)
        elif case=='unsafe-dt':fdtd.set('TimeStep','1e-8')
        elif case=='weight':mat.find('Weight').set('Epsilon','2,1,1')
        elif case=='anisotropy':mat.set('Isotropy','0')
        elif case=='active':prop.set('Kappa','-1,0,0')
        elif case=='hard-source':tree.find('.//Properties/Excitation').set('Type','1')
        xml=d/'model.xml';tree.write(xml,encoding='utf-8')
        with (d/'setup.log').open('w',encoding='utf-8') as log:
            p=subprocess.run([str(exe),str(xml),'--engine=sse' if case=='sse' else '--engine=basic','--no-simulation'],cwd=d,stdout=log,stderr=subprocess.STDOUT,timeout=30,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        text=(d/'setup.log').read_text()
        results[case]={'exit_code':p.returncode,'expected_diagnostic':expected,'pass':p.returncode!=0 and expected in text and 'Running FDTD engine' not in text}
    (out / 'summary.json').write_text(json.dumps(results,indent=2)+'\n',encoding='utf-8')
    return results
