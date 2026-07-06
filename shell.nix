{ pkgs ? import <nixpkgs> { } }:

pkgs.mkShell {
  packages = with pkgs; [
    nodejs_24
    git
    direnv
  ];

  shellHook = ''
    export PATH="$PWD/node_modules/.bin:$PATH"

    echo "pi extension dev shell"
    echo "  npm install        # install TypeScript and pi packages"
    echo "  npm run typecheck  # type-check the extension"
    echo "  npm run dev        # launch pi with this extension"
  '';
}
