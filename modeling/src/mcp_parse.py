"""Parse OP.GG MCP dataclass text into Python objects."""
import re


def parse_mcp_text(text):
    lines = [line for line in text.strip().splitlines() if line.strip()]
    classes = {}
    for line in lines:
        m = re.match(r"class (\w+):\s*(.*)", line)
        if m:
            name, fields = m.group(1), m.group(2).strip()
            classes[name] = [x.strip() for x in fields.split(",") if x.strip()]
    # Last line is the dataclass expression.
    expr = lines[-1]
    expr = expr.replace("null", "None").replace("false", "False").replace("true", "True")
    ns = {}
    for name, fields in classes.items():
        def make_init(fields_):
            def __init__(self, *args):
                self.args = args
                for i, f in enumerate(fields_):
                    setattr(self, f, args[i] if i < len(args) else None)
            return __init__
        ns[name] = type(name, (object,), {"__init__": make_init(fields)})
    return eval(expr, {}, ns)


def as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return list(value)
