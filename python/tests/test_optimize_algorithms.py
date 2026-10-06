"""Analytic regression coverage for the numpy-only search methods."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fairbeam.optimize import METHOD_CHOICES, Vary, make_goal, optimize


def run_objective(method, fn, n=4, seed=0, budget=120, noisy=False):
    target=np.zeros(n); bounds=[Vary(f"x{i}",-2,2,start=(1.5 if i==0 else -1.0),resolution=.0001) for i in range(n)]
    rng=np.random.default_rng(718)
    seen=[]
    def evaluate(p):
        x=np.array([p[f"x{i}"] for i in range(n)]); seen.append(x.copy())
        value=float(fn(x)) + (float(rng.normal(0,.0001)) if noisy else 0)
        return {"metrics":{"f0_ghz":1+np.sqrt(max(0,value))*0.01}}
    result=optimize(bounds,[make_goal("f0",1.0)],evaluate,method=method,max_evals=budget,seed=seed,f0_tol_pct=1e-8)
    return result,seen


class Algorithms(unittest.TestCase):
    def test_choices_and_all_methods_start_bounded_and_obey_budget(self):
        self.assertEqual(METHOD_CHOICES, ("auto","secant","nelder-mead","bayesian","cma-es","particle-swarm","genetic","trust-region"))
        methods=METHOD_CHOICES[2:]
        for method in methods:
            with self.subTest(method=method):
                result, seen=run_objective(method,lambda x: float(x@x),budget=45)
                self.assertEqual(seen[0][0],1.5)
                self.assertEqual(seen[0][1],-1.0)
                self.assertLessEqual(len(seen),45)
                self.assertTrue(np.all(np.asarray(seen)>=-2))
                self.assertTrue(np.all(np.asarray(seen)<=2))
                self.assertLess(result["best"]["cost"], result["start"]["cost"])

    def test_noisy_stochastic_methods_are_seed_reproducible(self):
        for method in ("bayesian","cma-es","particle-swarm","genetic"):
            a,pa=run_objective(method,lambda x: float(x@x),n=4,seed=23,budget=30,noisy=True)
            b,pb=run_objective(method,lambda x: float(x@x),n=4,seed=23,budget=30,noisy=True)
            np.testing.assert_array_equal(pa, pb)
            for left, right in zip(a["history"], b["history"]):
                self.assertEqual(left["params"], right["params"])
                self.assertEqual(left["cost"], right["cost"])

    def test_rosenbrock_and_arbitrary_dimensions(self):
        rosen=lambda x: float(np.sum(100*(x[1:]-x[:-1]**2)**2+(1-x[:-1])**2))
        for method in ("bayesian","cma-es","particle-swarm","genetic","trust-region","nelder-mead"):
            result,_=run_objective(method,rosen,n=5,budget=150)
            self.assertLess(result["best"]["cost"],result["start"]["cost"],method)

    def test_positive_dimensions_above_legacy_limit(self):
        result,_=run_objective("cma-es",lambda x: float(np.sum((x-.25)**2)),n=7,budget=25)
        self.assertEqual(len(result["best"]["params"]),7)


if __name__ == "__main__":
    unittest.main()
