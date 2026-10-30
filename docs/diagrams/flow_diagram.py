from diagrams import Diagram, Edge, Cluster
from diagrams.custom import Custom
from diagrams.programming.framework import NextJs
from diagrams.programming.language import Nodejs


graph_attr = {
    "fontname": "sans-serif bold",
    "fontsize": "18",
    "splines": "spline",
    "consolidate": "false",
    "labelloc": "t",
    "labeljust": "c",
    "layout": "dot",
    "compound": "true",
}
edge_attr = {
    "fontsize": "10",
    "style": "bold"
}
node_attr = {
    "fontsize": "12",
}

title = "ACE Plugin Flow"

with Diagram(title, show=False, graph_attr=graph_attr, edge_attr=edge_attr, node_attr=node_attr, filename="ace_diagram"):
    with Cluster("i2b2 Webclient"):
        ace_plugin = Custom("ACE Plugin", icon_path="./icons/ace.png")
    with Cluster("i2b2 Hive"):
        i2b2_cells = Custom("", icon_path="./icons/i2b2.png")
    with Cluster(""):
        claude_ai = Custom("Claude AI", icon_path="./icons/claude-ai.png")
    with Cluster(" "):
        pubmed = Custom("PubMed", icon_path="./icons/pubmed.png")
    with Cluster("Web API"):
        ace_app = NextJs("ACE")
        duckdb = Custom("DuckDB", icon_path="./icons/duckdb.png")

    ace_plugin \
        >> Edge(label="Clinical Question", fontsize="12", minlen="2") \
        >> ace_app
    ace_plugin \
        << Edge(label="Query XML", fontsize="12", minlen="2", reverse=True) \
        << ace_app

    ace_plugin \
        >> Edge(label="Query XML", fontsize="12", minlen="2") \
        >> i2b2_cells
    ace_plugin << Edge(label="Patient Counts", fontsize="12",
                       minlen="2", reverse=True) << i2b2_cells

    ace_app \
        >> Edge(style="dashed,bold", forward=True, reverse=True, minlen="2") \
        >> [claude_ai, pubmed, duckdb]
