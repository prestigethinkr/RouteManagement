import gradio as gr
import folium
import numpy as np
import networkx as nx
from scipy.spatial.distance import pdist, squareform
import json

# --- 1. Peta Interaktif untuk Memilih Lokasi (JavaScript & Leaflet) ---
# Trik ini menggunakan HTML & JS untuk menangkap klik di browser user.
map_picker_html = """
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<div id="map_picker" style="height: 500px; border-radius: 10px; border: 2px solid #ddd;"></div>
<script>
    // Inisialisasi peta (pusat di area Bandung/Padalarang sebagai contoh)
    var mapPicker = L.map('map_picker').setView([-6.8400, 107.4780], 13);
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(mapPicker);

    var clickedMarkers = [];
    var currentCoords = [];

    // Fungsi saat peta diklik
    function onMapClick(e) {
        var lat = e.latlng.lat;
        var lng = e.latlng.lng;
        var id = clickedMarkers.length + 1;

        // Tambah marker ke peta
        var marker = L.marker([lat, lng]).addTo(mapPicker)
            .bindPopup("Lokasi " + id).openPopup();
        
        clickedMarkers.push(marker);
        currentCoords.push([lat, lng]);

        // Masukkan koordinat ke hidden textbox Gradio agar bisa dibaca Python
        // Kita cari elemen textarea Gradio yang kita set sebagai input nanti
        var gradioInput = document.querySelector('#latlng_input textarea');
        if (gradioInput) {
            gradioInput.value = JSON.stringify(currentCoords);
            // Trigger event input agar Gradio tahu isinya berubah
            gradioInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    mapPicker.on('click', onMapClick);

    // Fungsi untuk reset map (dipanggil via JS Gradio)
    window.resetMapPicker = function() {
        for(var i = 0; i < clickedMarkers.length; i++){
            mapPicker.removeLayer(clickedMarkers[i]);
        }
        clickedMarkers = [];
        currentCoords = [];
        var gradioInput = document.querySelector('#latlng_input textarea');
        if(gradioInput) { gradioInput.value = ""; }
    }
</script>
"""

# --- 2. Fungsi Logika Python (TSP Solver & Folium Renderer) ---
def solve_efficient_route(coords_json):
    try:
        if not coords_json or coords_json == "" or coords_json == "[]":
            return None, "⚠️ Silakan klik minimal 2 lokasi pada peta di atas terlebih dahulu."
        
        # Parsing koordinat dari JS
        coords = json.loads(coords_json)
        n = len(coords)
        
        if n < 2:
            return None, "⚠️ Pilih minimal 2 titik lokasi."
            
        # Penamaan otomatis (Lokasi 1, 2, dst. Titik 1 dianggap Start)
        names = [f"Lokasi {i+1}" for i in range(n)]
        names[0] += " (START)"
        
        # Hitung matriks jarak (Euclidean sederhana)
        dist_matrix = squareform(pdist(coords))
        
        # Buat graf dan selesaikan TSP (Linear Route, tidak kembali ke awal)
        G = nx.from_numpy_array(dist_matrix)
        # Aproksimasi TSP, cycle=False agar rute linear
        route_indices = nx.approximation.traveling_salesman_problem(G, cycle=False)
        
        # --- Membuat Peta Output dengan Folium ---
        # Titik tengah peta diambil dari lokasi pertama
        m = folium.Map(location=coords[route_indices[0]], zoom_start=14)
        
        path_coords = []
        route_names = []
        
        for step, idx in enumerate(route_indices):
            lat_lon = coords[idx]
            path_coords.append(lat_lon)
            
            # Buat teks urutan (Start -> 2 -> 3 -> End)
            if step == 0: order_txt = "🚀 START"
            elif step == len(route_indices)-1: order_txt = f"🏁 FINISH (Ke-{step+1})"
            else: order_txt = f"📍 Urutan Ke-{step+1}"
            
            route_names.append(f"{step+1}. Lokasi {idx+1}")
            
            # Warna marker
            color = "green" if step == 0 else "red" if step == len(route_indices)-1 else "blue"
            
            folium.Marker(
                location=lat_lon,
                popup=f"<b>{order_txt}</b><br>Asal Klik: Lokasi {idx+1}",
                icon=folium.Icon(color=color, icon="info-sign"),
                tooltip=f"{step+1}. Lokasi {idx+1}"
            ).add_to(m)
            
        # Gambar garis jalur
        folium.PolyLine(
            path_coords, 
            color="#2ecc71", 
            weight=5, 
            opacity=0.8,
            dash_array="10"
        ).add_to(m)
        
        map_html = m._repr_html_()
        route_text = " ➡️ ".join(route_names)
        
        return map_html, f"✅ Rute Optimal Ditemukan:\n{route_text}\n\nTotal destinasi: {n} rumah."
        
    except Exception as e:
        return None, f"❌ Terjadi kesalahan: {str(e)}"

# --- 3. Antarmuka Gradio (UI/UX) ---
with gr.Blocks(theme=gr.themes.Default(primary_hue="emerald"), css=".gradio-container {background-color: #f9f9f9}") as app:
    gr.Markdown("# 🌙 Peta Silaturahmi Lebaran Efisien")
    gr.Markdown("Selamat Lebaran! Agar salam-salaman besok efektif dan tidak boros bensin, mari atur rutenya. Gunakan peta gratis di bawah untuk memilih rumah kerabat.")
    
    with gr.Row():
        # Kolom Kiri: Input (Map Picker)
        with gr.Column(scale=1):
            gr.Markdown("### 1️⃣ Pilih Lokasi di Peta\nKlik pada peta di bawah untuk menandai rumah yang ingin dikunjungi. Titik **pertama** yang Anda klik akan dianggap sebagai **titik START (Rumah Anda)**.")
            
            # Komponen HTML untuk menampilkan map picker Leaflet
            gr.HTML(map_picker_html)
            
            # Hidden textbox untuk komunikasi JS -> Python (Harus diberi elem_id agar JS bisa menemukan)
            latlng_input = gr.Textbox(label="Koordinat Terpilih (JSON)", visible=False, elem_id="latlng_input")
            
            with gr.Row():
                clear_btn = gr.Button("🗑️ Reset Map", variant="secondary")
                submit_btn = gr.Button("🚀 Hitung Rute Tercepat", variant="primary")
                
            # Gunakan JavaScript sederhana di Gradio untuk memanggil fungsi reset di window
            clear_btn.click(None, None, None, js="() => { window.resetMapPicker(); }")

        # Kolom Kanan: Output (Hasil Rute)
        with gr.Column(scale=1):
            gr.Markdown("### 2️⃣ Hasil Rute Optimal")
            output_map = gr.HTML(label="Peta Rute")
            output_text = gr.Textbox(label="Urutan Kunjungan", lines=4)

    # Logika tombol submit
    submit_btn.click(
        fn=solve_efficient_route,
        inputs=latlng_input,
        outputs=[output_map, output_text]
    )

if __name__ == "__main__":
    app.launch()