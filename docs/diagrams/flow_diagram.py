from diagrams import Diagram, Edge
from diagrams.custom import Custom
from diagrams.programming.framework import React


graph_attr = {
    "fontname": "sans-serif bold",
    "fontsize": "18",
    "splines": "spline",
    "consolidate": "false",
    "labelloc": "t",
    "labeljust": "c",
}
edge_attr = {
    "fontsize": "10",
    "style": "bold"
}

title = "ACE Plugin Flow"

with Diagram(title, show=False, graph_attr=graph_attr, edge_attr=edge_attr, filename="ace_diagram"):
    ace_plugin = Custom("ACE Plugin", icon_path="./icons/ace.png")
    ace_app = React("ACE Web Application")
    i2b2_cells = Custom("i2b2 Cells", icon_path="./icons/i2b2.png")
    claude_ai = Custom("Claude AI", icon_path="./icons/claude-ai.png")
    pubmed = Custom("PubMed", icon_path="./icons/pubmed.png")
    duckdb = Custom("DuckDB", icon_path="./icons/duckdb.png")

    ace_plugin >> Edge(label="Clinical Question") >> ace_app
    ace_plugin << Edge(label="Query XML", reverse=True) << ace_app

    ace_plugin >> Edge(label="Query XML") >> i2b2_cells
    ace_plugin << Edge(label="Patient Counts", reverse=True) << i2b2_cells

    ace_app >> [claude_ai, pubmed, duckdb]
