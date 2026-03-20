import gradio as gr
import folium
import numpy as np
import networkx as nx
from scipy.spatial.distance import pdist, squareform

def solve_route(locations_text):
    try:
        # Parsing input teks menjadi nama dan koordinat
        lines = [line.strip() for line in locations_text.strip().split('\n') if line.strip()]
        names = []
        coords = []
        
        for line in lines:
            parts = line.split(',')
            names.append(parts[0].strip())
            coords.append([float(parts[1].strip()), float(parts[2].strip())])
            
        if len(coords) < 2:
            return "Masukkan minimal 2 lokasi untuk membuat rute.", None
            
        # Menghitung matriks jarak antar titik (Euclidean/Haversine sederhana)
        dist_matrix = squareform(pdist(coords))
        
        # Membuat graf dan menyelesaikan TSP menggunakan NetworkX
        G = nx.from_numpy_array(dist_matrix)
        
        # Menggunakan algoritma aproksimasi TSP bawaan NetworkX
        # cycle=False karena kita hanya ingin rute linear dari titik 1 ke terakhir, bukan kembali ke awal
        route_indices = nx.approximation.traveling_salesman_problem(G, cycle=False)
        
        # Membuat Peta Interaktif dengan Folium
        # Titik tengah peta diambil dari lokasi pertama
        m = folium.Map(location=coords[route_indices[0]], zoom_start=14)
        
        # Menambahkan marker dan jalur
        path_coords = []
        route_names = []
        
        for step, idx in enumerate(route_indices):
            lat_lon = coords[idx]
            path_coords.append(lat_lon)
            route_names.append(names[idx])
            
            # Warna marker: Hijau (Start), Merah (End), Biru (Tujuan di tengah)
            color = "green" if step == 0 else "red" if step == len(route_indices)-1 else "blue"
            
            folium.Marker(
                location=lat_lon,
                popup=f"Urutan {step+1}: {names[idx]}",
                icon=folium.Icon(color=color, icon="info-sign"),
                tooltip=f"{step+1}. {names[idx]}"
            ).add_to(m)
            
        # Menggambar garis rute optimal
        folium.PolyLine(
            path_coords, 
            color="#3388ff", 
            weight=4, 
            opacity=0.8,
            dash_array="10"
        ).add_to(m)
        
        # Output HTML Peta dan Teks Rute
        map_html = m._repr_html_()
        route_result = " ➡️ ".join(route_names)
        
        return map_html, f"✨ Rute Paling Efisien:\n{route_result}"
        
    except Exception as e:
        return None, f"Terjadi kesalahan format: {str(e)}\nPastikan formatnya: Nama, Latitude, Longitude"

# UI Gradio
with gr.Blocks(theme=gr.themes.Soft()) as app:
    gr.Markdown("# 🌙 Navigator Silaturahmi Lebaran")
    gr.Markdown("Masukkan daftar rumah yang ingin dikunjungi. Sistem akan menghitung graf rute paling efisien menggunakan algoritma TSP (*Traveling Salesperson Problem*).")
    
    with gr.Row():
        with gr.Column(scale=1):
            gr.Markdown("### 📍 Input Lokasi\nFormat: `Nama Lokasi, Latitude, Longitude` (Satu lokasi per baris)")
            
            default_input = """Rumah Kita (Start), -6.8400, 107.4780
Rumah Nenek, -6.8450, 107.4850
Rumah Uwak, -6.8350, 107.4700
Rumah Mertua, -6.8500, 107.4900
Teman SMA, -6.8300, 107.4800"""
            
            lokasi_input = gr.Textbox(
                lines=8, 
                value=default_input, 
                label="Daftar Destinasi"
            )
            submit_btn = gr.Button("Hitung Rute Tercepat 🚀", variant="primary")
            
        with gr.Column(scale=2):
            output_rute_text = gr.Textbox(label="Urutan Silaturahmi", lines=2)
            output_map = gr.HTML(label="Peta Interaktif")

    submit_btn.click(
        fn=solve_route,
        inputs=lokasi_input,
        outputs=[output_map, output_rute_text]
    )

if __name__ == "__main__":
    app.launch()
