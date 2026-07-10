"""
Script pentru generarea iconițelor PNG pentru plugin-ul Chrome.
Rulați acest script pentru a genera fișierele icon16.png, icon48.png și icon128.png.

Necesită: pip install Pillow cairosvg
"""

import os
import sys

def create_icons_with_pillow():
    """Creează iconițe folosind Pillow (fără dependență de SVG)."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("Instalați Pillow: pip install Pillow")
        return False
    
    sizes = [16, 48, 128]
    icons_dir = os.path.dirname(os.path.abspath(__file__))
    
    for size in sizes:
        # Creează imagine nouă
        img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        
        # Cerc de fundal (gradient simulat cu cercuri concentrice)
        center = size // 2
        radius = int(size * 0.44)
        
        # Desenează cercul principal
        for i in range(radius, 0, -1):
            # Gradient de la #4fc3f7 la #29b6f6
            ratio = i / radius
            r = int(79 * ratio + 41 * (1 - ratio))
            g = int(195 * ratio + 182 * (1 - ratio))
            b = int(247 * ratio + 246 * (1 - ratio))
            draw.ellipse(
                [center - i, center - i, center + i, center + i],
                fill=(r, g, b, 255)
            )
        
        # Difuzor (Speaker icon)
        white = (255, 255, 255, 255)
        line_w = max(2, size // 16)
        
        # Corpul difuzorului (dreptunghi)
        body_w = int(size * 0.12)
        body_h = int(size * 0.22)
        body_x = int(size * 0.25)
        body_y = center - body_h // 2
        draw.rectangle(
            [body_x, body_y, body_x + body_w, body_y + body_h],
            fill=white
        )
        
        # Conul difuzorului (triunghi)
        cone_tip_x = body_x
        cone_end_x = body_x + int(size * 0.22)
        cone_top_y = center - int(size * 0.30)
        cone_bot_y = center + int(size * 0.30)
        draw.polygon(
            [(body_x + body_w, body_y),
             (body_x + body_w, body_y + body_h),
             (cone_end_x, cone_bot_y),
             (cone_end_x, cone_top_y)],
            fill=white
        )
        
        # Unde sonore (arcuri)
        arc_x = cone_end_x + int(size * 0.04)
        
        # Unda mică
        r1 = int(size * 0.12)
        draw.arc(
            [arc_x, center - r1, arc_x + r1 * 2, center + r1],
            -45, 45,
            fill=white,
            width=line_w
        )
        
        # Unda medie
        r2 = int(size * 0.22)
        draw.arc(
            [arc_x, center - r2, arc_x + r2 * 2, center + r2],
            -45, 45,
            fill=white,
            width=line_w
        )
        
        # Salvează imaginea
        output_path = os.path.join(icons_dir, f'icon{size}.png')
        img.save(output_path, 'PNG')
        print(f"Creat: {output_path}")
    
    return True


def create_simple_icons():
    """Creează iconițe simple bazate pe bytes (backup)."""
    # Iconițe PNG minimaliste create programatic
    import struct
    import zlib
    
    def create_png(width, height, pixels):
        """Creează un fișier PNG din date pixel."""
        def png_chunk(chunk_type, data):
            chunk_len = struct.pack('>I', len(data))
            chunk_crc = struct.pack('>I', zlib.crc32(chunk_type + data) & 0xffffffff)
            return chunk_len + chunk_type + data + chunk_crc
        
        # PNG header
        header = b'\x89PNG\r\n\x1a\n'
        
        # IHDR chunk
        ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
        ihdr = png_chunk(b'IHDR', ihdr_data)
        
        # IDAT chunk (image data)
        raw_data = b''
        for row in pixels:
            raw_data += b'\x00'  # Filter byte
            for r, g, b, a in row:
                raw_data += bytes([r, g, b, a])
        
        compressed = zlib.compress(raw_data, 9)
        idat = png_chunk(b'IDAT', compressed)
        
        # IEND chunk
        iend = png_chunk(b'IEND', b'')
        
        return header + ihdr + idat + iend
    
    def create_icon_pixels(size):
        """Creează matricea de pixeli pentru o iconiță."""
        pixels = []
        center = size // 2
        radius = size // 2 - 2
        
        for y in range(size):
            row = []
            for x in range(size):
                # Distanța de la centru
                dx = x - center
                dy = y - center
                dist = (dx * dx + dy * dy) ** 0.5
                
                if dist <= radius:
                    # În cerc - culoare albastră
                    row.append((79, 195, 247, 255))  # #4fc3f7
                else:
                    # Transparent
                    row.append((0, 0, 0, 0))
            pixels.append(row)
        
        return pixels
    
    icons_dir = os.path.dirname(os.path.abspath(__file__))
    
    for size in [16, 48, 128]:
        pixels = create_icon_pixels(size)
        png_data = create_png(size, size, pixels)
        
        output_path = os.path.join(icons_dir, f'icon{size}.png')
        with open(output_path, 'wb') as f:
            f.write(png_data)
        print(f"Creat (simplu): {output_path}")
    
    return True


if __name__ == '__main__':
    print("Generare iconițe pentru Ro-DeepVoice Plugin...")
    
    # Încearcă mai întâi cu Pillow
    if not create_icons_with_pillow():
        print("\nSe încearcă metoda alternativă...")
        create_simple_icons()
    
    print("\nIconițe generate cu succes!")
